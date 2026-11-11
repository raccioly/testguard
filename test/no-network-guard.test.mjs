// @req FR-10
// The network guard the write-boundary acceptance tests preload (#239).
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FIXTURE_GIT } from './helpers/git.mjs';
import { NETWORK_GUARD } from './helpers/write-boundary.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'cli', 'testguard.mjs');
const made = [];
const dir = (prefix = 'tg-scratch-') => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
describe('the network guard the acceptance tests rely on', () => {
  it('records and refuses a TCP connection, a listen and a name lookup, and lets a local socket path through', () => {
    const log = join(dir(), 'net.log');
    writeFileSync(log, '');
    const script = `
      const net = require('node:net'); const dns = require('node:dns');
      const tried = [];
      for (const attempt of [() => net.connect({ host: '192.0.2.1', port: 9 }), () => net.createServer().listen(0), () => dns.lookup('example.invalid', () => {})]) {
        try { attempt(); tried.push('allowed'); } catch (error) { tried.push('refused'); }
      }
      try { net.connect({ path: '/nonexistent-tg.sock' }).on('error', () => {}); tried.push('local-allowed'); } catch { tried.push('local-refused'); }
      console.log(tried.join(','));`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--import=${NETWORK_GUARD}`, TESTGUARD_NETWORK_LOG: log } });
    expect(r.stdout.trim()).toBe('refused,refused,refused,local-allowed');
    expect(readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')[1])).toEqual(['connect', 'listen', 'dns-lookup']);
  });
});
