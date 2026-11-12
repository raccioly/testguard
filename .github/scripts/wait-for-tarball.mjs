#!/usr/bin/env node
/**
 * Wait until the npm tarball of this version is downloadable.
 *
 * `npm publish` returns before the registry serves the file: it lagged the
 * listing by two to five minutes on 0.23.0 and 0.23.1. Anything that installs
 * or hashes the tarball (the Homebrew checksum, a user who just saw the
 * release) must not run before that. Bounded: a registry that never serves it
 * fails the job instead of hanging it.
 *
 *   usage: wait-for-tarball.mjs [--version <v>] [--registry <url>] [--wait <s>] [--interval <s>]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const tarballUrl = (registry, version) => `${registry.replace(/\/$/, '')}/testguard-cli/-/testguard-cli-${version}.tgz`;

/** One GET. `ok` only for a 200 whose body starts with the gzip magic: an HTML error page with a 200 is not a tarball. */
export async function probeTarball(url, fetchFn = fetch) {
  try {
    const res = await fetchFn(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (res.status !== 200) return { ok: false, why: `HTTP ${res.status}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return { ok: false, why: `200 but not a gzip tarball (${bytes.length} bytes)` };
    return { ok: true, bytes: bytes.length };
  } catch (error) {
    return { ok: false, why: `network error: ${error.message}` };
  }
}

export async function waitForTarball({ url, waitMs, intervalMs, fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const deadline = now() + waitMs;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const result = await probeTarball(url, fetchFn);
    if (result.ok) return { ok: true, attempts, bytes: result.bytes };
    if (now() >= deadline) return { ok: false, attempts, why: result.why };
    await sleep(intervalMs);
  }
}

export async function main(argv, deps = {}) {
  const { values } = parseArgs({ args: argv, options: { version: { type: 'string' }, registry: { type: 'string', default: 'https://registry.npmjs.org' }, wait: { type: 'string', default: '900' }, interval: { type: 'string', default: '15' } } });
  const version = values.version ?? JSON.parse(readFileSync('package.json', 'utf8')).version;
  const wait = Number(values.wait);
  const interval = Number(values.interval);
  if (!Number.isFinite(wait) || wait < 0 || !Number.isFinite(interval) || interval <= 0) { console.error('--wait must be >= 0 and --interval > 0 (seconds)'); return 2; }
  const url = tarballUrl(values.registry, version);
  const result = await waitForTarball({ url, waitMs: wait * 1000, intervalMs: interval * 1000, ...deps });
  if (!result.ok) {
    console.error(`::error::${url} is not downloadable after ${result.attempts} attempt(s) over ${wait}s — last: ${result.why}. The publish may still be propagating; re-run this job, nothing downstream ran.`);
    return 1;
  }
  console.log(`${url} is downloadable (${result.bytes} bytes, attempt ${result.attempts}).`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main(process.argv.slice(2)));
