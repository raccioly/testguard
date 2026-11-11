// @req FR-10
// The declared write boundary (#239), measured with the real runners. For each
// fixture the CLI probes a project in a sandbox whose only writable places are
// the scratch directory, the --out path and git's worktree metadata. Two runs:
//
//   read-only  node_modules made `chmod -R a-w`: the verdicts must still be
//              the oracle's. A runner that tries to write its cache there fails
//              quietly (vitest, jest), so this half alone cannot see a leak.
//   writable   a real copy of node_modules: the diff of that copy is what
//              catches a cache a read-only install would have swallowed.
//
// TMPDIR and HOME point at sentinel directories that start empty, so a file
// written to either is a write outside the boundary. Expectations come from
// the fixtures' own expected.json, which was verified by hand.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FIXTURE_GIT } from './helpers/git.mjs';
import { NETWORK_GUARD, changes, chmodTree, copyTree, listing, makeDir } from './helpers/write-boundary.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'cli', 'testguard.mjs');
const PYTHON = process.env.TESTGUARD_PYTHON || 'python3';
const HAS_PYTHON = spawnSync(PYTHON, ['-c', 'import sys']).status === 0;
const PW_FIXTURE = join(ROOT, 'fixtures', 'known-answer-playwright');
const HAS_PLAYWRIGHT = existsSync(join(PW_FIXTURE, 'node_modules', '@playwright', 'test')) && existsSync(join(PW_FIXTURE, 'node_modules', 'vitest'));

const FIXTURES = [
  { name: 'vitest', dir: 'known-answer', runner: 'vitest', nm: join(ROOT, 'node_modules'), dirty: true, writableRun: true },
  { name: 'jest', dir: 'known-answer-jest', runner: 'jest', nm: join(ROOT, 'node_modules') },
  { name: 'python (unittest)', dir: 'known-answer-python', runner: 'unittest', skip: !HAS_PYTHON },
  { name: 'playwright + vitest', dir: 'known-answer-playwright', runner: 'auto', nm: join(PW_FIXTURE, 'node_modules'), skip: !HAS_PLAYWRIGHT },
];

const git = (cwd, ...args) => {
  const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'user.email=f@example.invalid', '-c', 'user.name=f', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
};

/**
 * Probe one fixture inside a sandbox and report what moved outside the boundary.
 * `nodeModules` is a private copy (or undefined for Python): read-only or writable.
 */
function boundaryRun(fixture, expected, nodeModules, { dirty = false } = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), 'tg-boundary-'));
  const project = join(sandbox, 'project');
  const scratch = makeDir(join(sandbox, 'scratch'));
  const tmp = makeDir(join(sandbox, 'tmp'));
  const home = makeDir(join(sandbox, 'home'));
  const out = join(sandbox, 'out', 'evidence.json');
  makeDir(dirname(out));
  cpSync(join(ROOT, 'fixtures', fixture.dir), project, { recursive: true, filter: (src) => !/node_modules|__pycache__|\.flake-counter|\.testguard|\.pytest_cache|test-results/.test(src) });
  git(project, 'init', '-q'); git(project, 'add', '-A'); git(project, 'commit', '-q', '-m', 'fixture');
  // A dirty tree makes probe run test discovery in the caller's own tree, where node_modules is the project's own
  // (a symlink to the read-only copy here, as an installed-beforehand container has it) and cannot be swapped for a scratch one.
  if (dirty) { writeFileSync(join(project, 'notes.txt'), 'untracked\n'); symlinkSync(nodeModules, join(project, 'node_modules'), 'dir'); }
  // vitest keeps an API token in the per-user data directory. Linux honors XDG_DATA_HOME, which TestGuard
  // redirects; macOS and Windows do not, and docs-canonical/SECURITY.md lists that as a limit, so it is skipped there.
  const userDataDir = (rel) => process.platform !== 'linux' && (rel === 'home/Library' || rel.startsWith('home/Library/') || rel.startsWith('home/AppData'));
  const outside = (rel) => userDataDir(rel) || rel === join('project', '.git', 'worktrees') || rel.startsWith(join('project', '.git', 'worktrees') + '/') || rel === 'scratch' || rel.startsWith('scratch/') || rel === join('out', 'evidence.json');
  const before = listing(sandbox, outside);
  const args = [CLI, 'probe', project, '--scratch-dir', scratch, '--out', out, '--runner', fixture.runner, '--confirm', String(expected.confirmRuns), '--budget', String(expected.budgetMs ?? 60_000), '--no-escalate', '--quiet', ...(nodeModules && !dirty ? ['--node-modules', nodeModules] : [])];
  const networkLog = join(sandbox, '..', `${basename(sandbox)}.net.log`);
  writeFileSync(networkLog, '');
  // The guard rides NODE_OPTIONS into TestGuard and every Node runner it starts: a socket or a name lookup lands in the log and is refused.
  const r = spawnSync('node', args, { encoding: 'utf8', timeout: 900_000, env: { ...process.env, NODE_OPTIONS: `--import=${NETWORK_GUARD}`, TESTGUARD_NETWORK_LOG: networkLog, TMPDIR: tmp, TMP: tmp, TEMP: tmp, HOME: home, XDG_CACHE_HOME: join(home, '.cache'), ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { PLAYWRIGHT_BROWSERS_PATH: join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright') }) } });
  const after = listing(sandbox, outside);
  const evidence = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : undefined;
  const network = readFileSync(networkLog, 'utf8');
  rmSync(networkLog, { force: true });
  return { sandbox, network, status: r.status, stderr: r.stderr, before, after, evidence, scratchLeft: readdirSync(scratch), tmpLeft: readdirSync(tmp), homeLeft: readdirSync(home) };
}

const verdicts = (evidence) => Object.fromEntries(evidence.records.map((r) => [`${r.claim.id}/${r.subject.id}`, r.verdict]));

describe.each(FIXTURES)('write boundary: $name', (fixture) => {
  const expected = JSON.parse(readFileSync(join(ROOT, 'fixtures', fixture.dir, 'expected.json'), 'utf8'));
  const oracle = Object.fromEntries(Object.entries(expected.expected).map(([k, v]) => [k, v.verdict]));
  let nmRo; let nmRw; let ro; let rw; let roDirty; const sandboxes = [];

  beforeAll(() => {
    if (fixture.skip) return;
    if (fixture.nm) {
      const holder = mkdtempSync(join(tmpdir(), 'tg-boundary-nm-'));
      sandboxes.push(holder);
      nmRo = join(holder, 'ro', 'node_modules'); makeDir(dirname(nmRo)); copyTree(fixture.nm, nmRo);
      if (fixture.writableRun) { nmRw = join(holder, 'rw', 'node_modules'); makeDir(dirname(nmRw)); copyTree(fixture.nm, nmRw); }
    }
    const nmRwBefore = nmRw ? listing(nmRw) : undefined;
    if (nmRo) chmodTree(nmRo, 'ro');
    try {
      ro = boundaryRun(fixture, expected, nmRo);
      if (!fixture.nm || fixture.writableRun) rw = boundaryRun(fixture, expected, nmRw);
      if (nmRo && fixture.dirty) roDirty = boundaryRun(fixture, expected, nmRo, { dirty: true });
      if (rw) rw.nmChanges = nmRw ? changes(nmRwBefore, listing(nmRw)) : undefined;
    } finally {
      if (nmRo) chmodTree(nmRo, 'rw'); // so cleanup can never fail on a read-only tree
      for (const r of [ro, rw, roDirty]) if (r) sandboxes.push(r.sandbox);
    }
  }, 1_800_000);

  afterAll(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

  it.skipIf(fixture.skip)('with a read-only node_modules, the verdicts are the oracle\'s', () => {
    expect(ro.stderr).not.toMatch(/Error:/);
    expect(ro.evidence, ro.stderr).toBeDefined();
    expect(verdicts(ro.evidence)).toEqual(oracle);
  });

  it.skipIf(fixture.skip || !fixture.dirty)('a dirty tree over a read-only node_modules is probed, not refused, and writes nothing outside the boundary', () => {
    expect(roDirty.evidence, roDirty.stderr).toBeDefined();
    expect(verdicts(roDirty.evidence)).toEqual(oracle);
    expect(roDirty.before.size).toBeGreaterThan(20);
    expect(changes(roDirty.before, roDirty.after)).toEqual({ created: [], removed: [], modified: [] });
  });

  it.skipIf(fixture.skip)('creates and modifies nothing outside the scratch dir, --out and .git/worktrees', () => {
    for (const run of [ro, rw].filter(Boolean)) {
      expect(run.before.size).toBeGreaterThan(20); // an empty walk cannot pass
      const { created, removed, modified } = changes(run.before, run.after);
      expect({ created, removed, modified }).toEqual({ created: [], removed: [], modified: [] });
      expect(run.network).toBe(''); // no socket, no name lookup, in TestGuard or any Node runner it started
      expect(run.tmpLeft).toEqual([]);
      if (process.platform === 'linux') expect(run.homeLeft).toEqual([]);
    }
  });

  it.skipIf(fixture.skip)('leaves a writable node_modules untouched, and the scratch directory empty', () => {
    if (rw?.nmChanges) {
      expect(listing(nmRw).size).toBeGreaterThan(100);
      expect(rw.nmChanges).toEqual({ created: [], removed: [], modified: [] });
    }
    if (rw) expect(rw.scratchLeft).toEqual([]);
    expect(ro.scratchLeft).toEqual([]);
  });
});
