import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import {ROOT,SURFACES,sandbox,PLACEHOLDER,formulaSha,setFormulaSha} from './helpers/release-project.mjs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/**
 * The script, spawned WITHOUT blocking the worker: the registry below lives on
 * this event loop, and `spawnSync` would freeze it while the child waits for a
 * response that can then never come.
 */
const sha256Of = (buf) => createHash('sha256').update(buf).digest('hex');

const runAsync = (dir, ...args) => new Promise((resolve) => {
  const child = spawn('node', [join(dir, '.github', 'scripts', 'sync-release-version.mjs'), ...args]);
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

/** A registry that answers each request from `responses` in order, repeating the last one. Records every path it was asked for. */
async function registry(responses) {
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    const r = responses[Math.min(paths.length - 1, responses.length - 1)];
    res.writeHead(r.status, { 'content-type': r.type ?? 'application/octet-stream' });
    res.end(r.body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, paths, close: () => new Promise((resolve) => server.close(resolve)) };
}

describe('sync-release-version: the Homebrew sha256 is a release surface, computed from the published tarball', () => {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const tarball = gzipSync(Buffer.from(`testguard-cli ${version} as npm serves it`));
  const ok = { status: 200, body: tarball };
  const fast = ['--interval', '0.01', '--wait', '5'];

  it('--sha256 waits through 404s while npm processes the publish, then writes the hash of the bytes the registry served — and only writes when it changes', async () => {
    const reg = await registry([{ status: 404 }, { status: 404 }, ok]);
    try {
      const { dir, run } = sandbox();
      setFormulaSha(dir, PLACEHOLDER);
      const first = await runAsync(dir, '--sha256', '--registry', reg.url, ...fast);
      expect(first.status, first.stderr).toBe(0);
      expect(reg.paths.length).toBeGreaterThanOrEqual(3);
      expect(new Set(reg.paths)).toEqual(new Set([`/testguard-cli/-/testguard-cli-${version}.tgz`])); // what Homebrew downloads
      expect(formulaSha(dir)).toBe(sha256Of(tarball));
      expect(first.stdout).toContain(`sha256 ${PLACEHOLDER} -> ${sha256Of(tarball)}`);

      const before = readFileSync(join(dir, 'packaging/homebrew/testguard.rb'), 'utf8');
      const again = await runAsync(dir, '--sha256', '--registry', reg.url, ...fast);
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('sha256 unchanged');
      expect(readFileSync(join(dir, 'packaging/homebrew/testguard.rb'), 'utf8')).toBe(before);
      expect(run('--check').status).toBe(0);
    } finally {
      await reg.close();
    }
  });

  it('--sha256 gives up after --wait and leaves the formula alone when the tarball never appears', async () => {
    const reg = await registry([{ status: 404 }]);
    try {
      const { dir, run } = sandbox();
      const r = await runAsync(dir, '--sha256', '--registry', reg.url, '--interval', '0.01', '--wait', '0.2');
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/not downloadable after \d+ attempt\(s\) over 0\.2s — last: HTTP 404/);
      // How many attempts fit in 0.2s is a wall-clock question; that it retries at all is
      // pinned by the 404-404-200 test above, which cannot pass without a third request.
      expect(reg.paths.length).toBeGreaterThanOrEqual(1);
      expect(formulaSha(dir)).not.toBe(PLACEHOLDER); // untouched: still the checkout's value
      expect(formulaSha(dir)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await reg.close();
    }
  });

  it('--sha256 never hashes a 200 that is not a gzip tarball (a registry error page would poison the formula)', async () => {
    const reg = await registry([{ status: 200, type: 'text/html', body: '<html>Service Unavailable</html>' }]);
    try {
      const { dir, run } = sandbox();
      const original = formulaSha(dir);
      const r = await runAsync(dir, '--sha256', '--registry', reg.url, '--interval', '0.01', '--wait', '0.05');
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/200 but not a gzip tarball/);
      expect(formulaSha(dir)).toBe(original);
    } finally {
      await reg.close();
    }
  });

  it('--check --online passes only when the formula hash matches the downloadable tarball; a mismatch or a missing tarball is drift', async () => {
    const reg = await registry([ok]);
    const gone = await registry([{ status: 404 }]);
    try {
      const { dir, run } = sandbox();
      setFormulaSha(dir, sha256Of(tarball));
      const match = await runAsync(dir, '--check', '--online', '--registry', reg.url);
      expect(match.status, match.stderr).toBe(0);
      expect(match.stdout).toMatch(/sha256 matches http:\/\/127\.0\.0\.1:\d+\/testguard-cli\/-\/testguard-cli-/);

      setFormulaSha(dir, 'a'.repeat(64));
      const mismatch = await runAsync(dir, '--check', '--online', '--registry', reg.url);
      expect(mismatch.status).toBe(1);
      expect(mismatch.stderr).toMatch(new RegExp(`sha256 ${'a'.repeat(64)} does not match the published tarball ${sha256Of(tarball)}`));
      expect(run('--check').status).toBe(0); // offline, the same formula is structurally fine: the mismatch is only visible online

      setFormulaSha(dir, sha256Of(tarball));
      const missing = await runAsync(dir, '--check', '--online', '--registry', gone.url);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toMatch(/tarball not downloadable — .*: HTTP 404/);
    } finally {
      await reg.close();
      await gone.close();
    }
  });
});
