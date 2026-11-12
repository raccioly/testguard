#!/usr/bin/env node
/**
 * Do not cut a release branch while the previous release still owes `main` a
 * commit. The Homebrew checksum lands on `main` as its own pull request after
 * each publish; a release branch cut before it merges conflicts with it, and
 * merging `main` into the release branch would change its tree and void the
 * tree-keyed evidence. So the order is enforced here: wait (bounded) until no
 * `chore/homebrew-sha-v*` pull request is open and the formula on `main`
 * carries the published tarball's hash, otherwise fail loudly.
 *
 *   usage: release-preflight.mjs [--wait <s>] [--interval <s>]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const HOMEBREW_BRANCH_PREFIX = 'chore/homebrew-sha-v';

/** What still blocks a cut. Empty means clear. */
export function blockers({ openPulls, formulaOk }) {
  const out = openPulls.filter((p) => p.headRefName?.startsWith(HOMEBREW_BRANCH_PREFIX)).map((p) => `${p.url ?? p.headRefName} (the previous release's Homebrew checksum) is still open`);
  if (!formulaOk) out.push('the Homebrew formula on main does not carry the hash of the published tarball (sync-release-version.mjs --check --online)');
  return out;
}

export async function waitUntilClear({ openPulls, formulaOk, waitMs, intervalMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const deadline = now() + waitMs;
  for (;;) {
    let found;
    try {
      found = blockers({ openPulls: await openPulls(), formulaOk: await formulaOk() });
    } catch (error) {
      found = [`could not check: ${error.message}`];
    }
    if (found.length === 0) return { ok: true, blockers: [] };
    if (now() >= deadline) return { ok: false, blockers: found };
    await sleep(intervalMs);
  }
}

export async function main(argv, deps = {}) {
  const { values } = parseArgs({ args: argv, options: { wait: { type: 'string', default: '1800' }, interval: { type: 'string', default: '60' } } });
  const wait = Number(values.wait);
  const interval = Number(values.interval);
  if (!Number.isFinite(wait) || wait < 0 || !Number.isFinite(interval) || interval <= 0) { console.error('--wait must be >= 0 and --interval > 0 (seconds)'); return 2; }
  const openPulls = deps.openPulls ?? (async () => JSON.parse(execFileSync('gh', ['pr', 'list', '--state', 'open', '--base', 'main', '--limit', '100', '--json', 'headRefName,url'], { encoding: 'utf8' })));
  const formulaOk = deps.formulaOk ?? (async () => spawnSync(process.execPath, ['.github/scripts/sync-release-version.mjs', '--check', '--online'], { stdio: 'inherit' }).status === 0);
  const result = await waitUntilClear({ openPulls, formulaOk, waitMs: wait * 1000, intervalMs: interval * 1000, ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.now ? { now: deps.now } : {}) });
  if (!result.ok) {
    for (const b of result.blockers) console.error(`::error::release not cut: ${b}`);
    console.error('Cutting now would open a release pull request that conflicts with that commit. Let it land (or fix it), then re-run the scheduled release.');
    return 1;
  }
  console.log('main carries the previous release\'s Homebrew checksum; clear to cut.');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main(process.argv.slice(2)));
