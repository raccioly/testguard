import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { resetConfigCache, webServerPort, foreignServerNote } from '../src/probe/runners/playwright.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

// #291: a Playwright config that reuses an existing server on a fixed port ran the scratch tree's specs
// against a server built from another checkout. A verdict from that server is never evidence about the
// probed tree: it is unverifiable, and the record names the cause.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'foreign-server-playwright');
const DEPS = join(ROOT, 'fixtures', 'known-answer-playwright', 'node_modules'); // npm ci there; this suite never runs a package manager
const INSTALLED = existsSync(join(DEPS, '@playwright', 'test'));

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const prepare = (port, reuse) => {
  const dir = mkdtempSync(join(tmpdir(), 'testguard-foreign-'));
  cpSync(FIXTURE, dir, { recursive: true });
  const config = join(dir, 'playwright.config.mjs');
  writeFileSync(config, readFileSync(config, 'utf8').replaceAll('__PORT__', String(port)).replaceAll('__REUSE__', reuse));
  symlinkSync(DEPS, join(dir, 'node_modules'), 'dir');
  const g = (...args) => { const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=f@example.invalid', '-c', 'user.name=f', ...args], { cwd: dir, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'fixture');
  return dir;
};

const startForeign = async (port) => {
  const dir = mkdtempSync(join(tmpdir(), 'testguard-foreign-origin-'));
  cpSync(FIXTURE, dir, { recursive: true }); // an unfaulted copy: the server of "another checkout"
  const child = spawn(process.execPath, ['server.mjs'], { cwd: dir, env: { ...process.env, TESTGUARD_FIXTURE_PORT: String(port) }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false);
    if (up) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { stop: () => { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); } };
};

const probeIt = (dir) => probe({ projectDir: dir, claims: loadClaims(join(dir, 'testguard.claims.json')), confirmRuns: 1, mode: 'worktree', escalate: false, budgetMs: 60_000, toolVersion: 'test' });

describe.skipIf(!INSTALLED)('a server from another checkout is never evidence', () => {
  const cleanup = [];
  afterAll(() => { for (const fn of cleanup.reverse()) fn(); resetConfigCache(); });

  const scenario = async (reuse, { foreign }) => {
    const port = await freePort();
    const dir = prepare(port, reuse);
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    if (foreign) { const f = await startForeign(port); cleanup.push(f.stop); }
    resetConfigCache();
    const evidence = await probeIt(dir);
    expect(validate('evidence', evidence).errors).toEqual([]);
    return { record: evidence.records[0], port };
  };

  it('control: with no foreign server the probe starts its own and the fault is killed', async () => {
    const { record } = await scenario('true', { foreign: false });
    expect(record.verdict).toBe('killed');
  }, 120_000);

  it('a config that reuses the foreign server is unverifiable, and the record names the reused server', async () => {
    const { record, port } = await scenario('true', { foreign: true });
    expect(record.verdict).toBe('unverifiable');
    expect(record.detail.reason).toBe('subject-not-executed');
    expect(record.detail.message).toContain(`port ${port}`);
    expect(record.detail.message).toMatch(/reused|reuse/i);
    expect(record.detail.message).toContain('TESTGUARD_WORKER');
  }, 120_000);

  it('reuseExistingServer: !process.env.CI refuses: TestGuard sets CI for the runner, config evaluation included', async () => {
    const { record } = await scenario('!process.env.CI', { foreign: true });
    expect(record.verdict).toBe('unverifiable');
    expect(record.detail.reason).toBe('defenders-failed-to-load');
    expect(record.detail.message).toMatch(/already used/);
  }, 120_000);
});

describe('the note on a webServer the run did not start', () => {
  it('reads a literal port, a url with a port, or says the port is computed', () => {
    expect(webServerPort("export default { webServer: { command: 'x', port: 4173 } }")).toBe(4173);
    expect(webServerPort("export default { webServer: { command: 'x', url: 'http://localhost:3000/health' } }")).toBe(3000);
    expect(webServerPort('export default { webServer: { command: "x", port: Number(process.env.PORT) } }')).toBeNull();
    expect(webServerPort('export default { testDir: "e2e" }')).toBeUndefined();
  });

  it('a config with a computed port gets the hedged note; one without a webServer gets none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'testguard-note-'));
    try {
      mkdirSync(join(dir, 'e2e'));
      writeFileSync(join(dir, 'e2e', 'a.spec.mjs'), '');
      writeFileSync(join(dir, 'playwright.config.mjs'), 'export default { testDir: "e2e", webServer: { command: "x", port: Number(process.env.PORT) } };');
      resetConfigCache();
      expect(await foreignServerNote(dir, ['e2e/a.spec.mjs'])).toMatch(/may have reused a server started from another tree.*TESTGUARD_WORKER/);
      expect(await foreignServerNote(dir, ['test/other.test.mjs'])).toBeUndefined(); // not a Playwright defender
      writeFileSync(join(dir, 'playwright.config.mjs'), 'export default { testDir: "e2e" };');
      resetConfigCache();
      expect(await foreignServerNote(dir, ['e2e/a.spec.mjs'])).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); resetConfigCache(); }
  });
});
