#!/usr/bin/env node
/**
 * A release pull request that cannot merge must fail the workflow that opened
 * it. v0.23.2's conflicted with the previous version's Homebrew checksum commit
 * and sat open, auto-merge armed and never firing, until someone looked.
 *
 * Polls the pull request (bounded). Succeeds when it is mergeable with
 * auto-merge armed. Fails at once on a conflict, and at the deadline on
 * anything else, saying which. A blocked state (checks still running) is the
 * normal one and counts as mergeable: this is not a wait for CI.
 *
 *   usage: await-mergeable.mjs <pr> [--wait <s>] [--interval <s>]
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** `ok` | `fail` | `wait`, with the reason. Pure. */
export function judge(view) {
  if (view.state === 'MERGED') return { verdict: 'ok', why: 'already merged' };
  if (view.state !== 'OPEN') return { verdict: 'fail', why: `the pull request is ${view.state}` };
  if (view.mergeable === 'CONFLICTING' || view.mergeStateStatus === 'DIRTY') return { verdict: 'fail', why: 'it conflicts with main (mergeable CONFLICTING)' };
  if (view.mergeable === 'MERGEABLE') return view.autoMergeRequest ? { verdict: 'ok', why: 'mergeable, auto-merge armed' } : { verdict: 'wait', why: 'mergeable but auto-merge is not armed' };
  return { verdict: 'wait', why: `mergeability is ${view.mergeable ?? 'unknown'}` };
}

export async function awaitMergeable({ view, waitMs, intervalMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const deadline = now() + waitMs;
  let last;
  for (;;) {
    let verdict;
    try {
      verdict = judge(await view());
    } catch (error) {
      verdict = { verdict: 'wait', why: `could not read the pull request: ${error.message}` };
    }
    last = verdict;
    if (verdict.verdict === 'ok') return { ok: true, why: verdict.why };
    if (verdict.verdict === 'fail') return { ok: false, why: verdict.why };
    if (now() >= deadline) return { ok: false, why: `still not mergeable after the wait: ${last.why}` };
    await sleep(intervalMs);
  }
}

export async function main(argv, deps = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { wait: { type: 'string', default: '300' }, interval: { type: 'string', default: '10' } } });
  const [pr] = positionals;
  const wait = Number(values.wait);
  const interval = Number(values.interval);
  if (!pr || !Number.isFinite(wait) || wait < 0 || !Number.isFinite(interval) || interval <= 0) { console.error('usage: await-mergeable.mjs <pr> [--wait <s>] [--interval <s>]'); return 2; }
  const view = deps.view ?? (async () => JSON.parse(execFileSync('gh', ['pr', 'view', pr, '--json', 'state,mergeable,mergeStateStatus,autoMergeRequest'], { encoding: 'utf8' })));
  const result = await awaitMergeable({ view, waitMs: wait * 1000, intervalMs: interval * 1000, ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.now ? { now: deps.now } : {}) });
  if (!result.ok) {
    console.error(`::error::${pr} cannot merge: ${result.why}. The release branch is stale or auto-merge was not armed; nothing will land it by itself. Close it, delete the branch and re-run the scheduled release once main is settled.`);
    return 1;
  }
  console.log(`${pr}: ${result.why}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main(process.argv.slice(2)));
