// @req FR-10
// --scratch-dir and TESTGUARD_SCRATCH_DIR on the command line (#239).
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

function repo() {
  const d = dir('tg-wb-repo-');
  const g = (...args) => spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd: d, encoding: 'utf8' });
  g('init', '-q');
  writeFileSync(join(d, 'a.txt'), 'a\n');
  g('add', '-A'); g('commit', '-qm', 'one');
  return d;
}

describe('the command line', () => {
  const cli = (args, env = {}) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

  it('refuses a scratch directory that does not exist with exit 2 before writing anything', () => {
    const repoDir = repo(); const parent = dir(); const missing = join(parent, 'nope');
    for (const [args, env] of [[['probe', repoDir, '--scratch-dir', missing], {}], [['probe', repoDir], { TESTGUARD_SCRATCH_DIR: missing }]]) {
      const r = cli(args, env);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/scratch directory .* is not usable: it does not exist/);
      expect(r.stderr).not.toMatch(/bug in testguard/); // a refusal, not a defect
    }
    expect(readdirSync(parent)).toEqual([]);
    expect(existsSync(join(repoDir, '.testguard'))).toBe(false);
  });

  it('accepts --scratch-dir only on the commands that run tests', () => {
    const r = cli(['claims', ROOT, '--scratch-dir', tmpdir()]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/--scratch-dir is only valid on probe, sweep, replay and admit/);
  });

  it('the flag wins over the environment variable', () => {
    const repoDir = repo(); const good = dir(); const bad = join(dir(), 'nope');
    expect(cli(['probe', repoDir, '--scratch-dir', bad], { TESTGUARD_SCRATCH_DIR: good }).status).toBe(2);
    const ok = cli(['probe', repoDir, '--scratch-dir', good, '--allow-empty'], { TESTGUARD_SCRATCH_DIR: bad });
    expect(ok.stderr).not.toMatch(/scratch directory/);
  });
});

