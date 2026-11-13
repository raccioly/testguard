// Orphaned scratch trees (#311): what is removed, and — as important — what
// never is. The registry side (real git repositories) is test/clean-worktrees.test.mjs. Pure rules over a scratch root built in a temp directory, with the
// process table, the host and the clock injected.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanOnStart, cleanOrphans, ORPHAN_AGE_MS, scanOrphans } from '../src/clean/orphans.mjs';
import { ownersDir, recordOwner } from '../src/clean/owner.mjs';
import { childScope, withScratchBase } from '../src/scratch-dir.mjs';
import { LOCK_NAME } from '../src/probe/worktree-lock.mjs';

// Real git repositories and real child processes: a loaded machine (a fan-out of probes) must not turn a slow start into a failure.
vi.setConfig({ testTimeout: 30_000 });
const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const root = (prefix = 'tg-clean-') => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(d); return d; };

const HOST = 'this-host';
const DEAD = 424242;
const LIVE = 31337;
const alive = (pid) => pid === LIVE;
const options = { alive, host: HOST };

/** A scratch tree named the way mkdtemp names one, with an owner record (or none). */
function tree(base, name, owner) {
  const path = join(base, name);
  mkdirSync(join(path, 'src'), { recursive: true });
  writeFileSync(join(path, 'src', 'a.mjs'), 'export const a = 1;\n');
  if (owner) {
    mkdirSync(ownersDir(base), { recursive: true });
    writeFileSync(join(ownersDir(base), `${name}.json`), JSON.stringify({ at: new Date().toISOString(), ...owner }));
  }
  return path;
}
const age = (path, ms) => { const t = new Date(Date.now() - ms); utimesSync(path, t, t); };
const names = (base) => readdirSync(base).filter((n) => n !== 'testguard-locks').sort();

describe('which scratch trees are orphans', () => {
  it('a tree whose owner is a dead process on this host is removed, with its owner record', () => {
    const base = root();
    tree(base, 'testguard-aaaaaa', { pid: DEAD, host: HOST });
    const report = cleanOrphans({ base, ...options });
    expect(report.removed.map((r) => [r.kind, r.reason])).toEqual([['scratch-tree', `its owner (pid ${DEAD}) is gone`]]);
    expect(names(base)).toEqual([]);
    expect(readdirSync(ownersDir(base))).toEqual([]);
  });

  it('a tree whose owner is alive is never touched, however old it is', () => {
    const base = root();
    const path = tree(base, 'testguard-bbbbbb', { pid: LIVE, host: HOST });
    age(path, 10 * ORPHAN_AGE_MS);
    expect(cleanOrphans({ base, ...options }).removed).toEqual([]);
    expect(names(base)).toEqual(['testguard-bbbbbb']);
  });

  it('a tree another host owns is never touched: this host cannot judge its pid', () => {
    const base = root();
    tree(base, 'testguard-cccccc', { pid: DEAD, host: 'elsewhere' });
    expect(cleanOrphans({ base, ...options }).removed).toEqual([]);
    expect(names(base)).toEqual(['testguard-cccccc']);
  });

  it('the owner record this tool writes names the host that wrote it', () => {
    const base = root();
    const path = join(base, 'testguard-dddddd');
    mkdirSync(path);
    const drop = recordOwner(base, path, { host: 'elsewhere' });
    const record = JSON.parse(readFileSync(join(ownersDir(base), 'testguard-dddddd.json')));
    expect(record).toMatchObject({ pid: process.pid, host: 'elsewhere' });
    // A tree on another machine's record is not this host's to judge, even once its pid is not running here.
    expect(scanOrphans(base, { alive: () => false, host: HOST }).orphans).toEqual([]);
    drop();
    expect(existsSync(join(ownersDir(base), 'testguard-dddddd.json'))).toBe(false);
  });

  it('a tree with no owner record is removed only when it is older than 24 hours', () => {
    const base = root();
    tree(base, 'testguard-eeeeee');
    const old = tree(base, 'testguard-ffffff');
    age(old, ORPHAN_AGE_MS + 60_000);
    const report = cleanOrphans({ base, ...options });
    expect(report.removed.map((r) => [r.kind, r.reason])).toEqual([['scratch-tree', 'no owner record and older than 24 hours']]);
    expect(names(base)).toEqual(['testguard-eeeeee']);
  });

  it('only the names this tool creates are ours: a directory someone else called testguard-<something> is left alone', () => {
    const base = root();
    for (const name of ['testguard-fixture-AbC123', 'testguard-locks-old', 'testguard-notes', 'tg-aaaaaa', 'testguard-aaaaaa.bak']) age(tree(base, name), 5 * ORPHAN_AGE_MS);
    expect(cleanOrphans({ base, ...options }).removed).toEqual([]);
    expect(names(base)).toHaveLength(5);
  });

  it('every other shape this tool creates is scratch too, by the same rules: child scopes, type-check and runner directories, and its random-named files', () => {
    const base = root();
    tree(base, 'testguard-child-ab12Cd', { pid: DEAD, host: HOST });
    for (const dirName of ['testguard-tc-ab12Cd', 'testguard-node-ab12Cd']) age(tree(base, dirName), 2 * ORPHAN_AGE_MS);
    const files = ['testguard-index-0123456789ab', 'testguard-run-0123456789ab.json', 'testguard-discovery-0123456789abcdef.json', 'testguard-vitest-list-0123456789abcdef.json', 'testguard-vitest-kinds-0123456789ab.json', 'testguard-playwright-kinds-0123456789ab.json'];
    for (const name of files) { writeFileSync(join(base, name), 'x'); age(join(base, name), 2 * ORPHAN_AGE_MS); }
    // A young one is a run in flight; a name that only looks similar is not ours.
    writeFileSync(join(base, 'testguard-run-fedcba987654.json'), 'x');
    writeFileSync(join(base, 'testguard-run-0123456789ab.txt'), 'x'); age(join(base, 'testguard-run-0123456789ab.txt'), 2 * ORPHAN_AGE_MS);
    const kinds = cleanOrphans({ base, ...options }).removed.map((r) => r.kind);
    expect(kinds.filter((k) => k === 'scratch-tree')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'scratch-file')).toHaveLength(files.length);
    expect(names(base)).toEqual(['testguard-run-0123456789ab.txt', 'testguard-run-fedcba987654.json']);
  });
});

describe('stale locks', () => {
  const lockAt = (path, owner) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify({ at: 'x', ...owner })); };

  it('a worker-slot lock and a worktree lock whose owner is gone are removed; a live or foreign one stays', () => {
    const base = root();
    const slots = join(base, 'testguard-locks', 'worker-slots');
    lockAt(join(slots, 'slot-0.lock'), { pid: DEAD, host: HOST });
    lockAt(join(slots, 'slot-1.lock'), { pid: LIVE, host: HOST });
    lockAt(join(slots, 'slot-2.lock'), { pid: DEAD, host: 'elsewhere' });
    lockAt(join(base, 'testguard-locks', 'abc', LOCK_NAME), { pid: DEAD, host: HOST });
    const report = cleanOrphans({ base, ...options });
    expect(report.removed.map((r) => r.kind)).toEqual(['stale-lock', 'stale-lock']);
    expect(readdirSync(slots).sort()).toEqual(['slot-1.lock', 'slot-2.lock']);
    expect(existsSync(join(base, 'testguard-locks', 'abc', LOCK_NAME))).toBe(false);
  });

  it('an unreadable lock is not stale: it may be a write in progress', () => {
    const base = root();
    const path = join(base, 'testguard-locks', 'worker-slots', 'slot-0.lock');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{"pid":');
    expect(cleanOrphans({ base, ...options }).removed).toEqual([]);
  });
});

describe('--dry-run, the time cap and failure', () => {
  it('a dry run lists every orphan and removes nothing', () => {
    const base = root();
    tree(base, 'testguard-gggggg', { pid: DEAD, host: HOST });
    const report = cleanOrphans({ base, dryRun: true, measure: true, ...options });
    expect(report.dryRun).toBe(true);
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].bytes).toBeGreaterThan(0);
    expect(names(base)).toEqual(['testguard-gggggg']);
    expect(existsSync(join(ownersDir(base), 'testguard-gggggg.json'))).toBe(true);
  });

  const four = () => { const base = root(); for (const n of ['hhhhh1', 'hhhhh2', 'hhhhh3', 'hhhhh4']) tree(base, `testguard-${n}`, { pid: DEAD, host: HOST }); return base; };

  it('the scan is bounded: past its budget it stops looking, says so, and a later run finishes', () => {
    const base = four();
    // Each look at the clock costs 10 ms against a 25 ms budget.
    let t = 0;
    const report = cleanOrphans({ base, budgetMs: 25, now: () => (t += 10), ...options });
    expect(report.capped).toBe(true);
    expect(names(base).length).toBe(4 - report.removed.length);
    expect(names(base).length).toBeGreaterThan(0);
    expect(cleanOrphans({ base, ...options }).capped).toBe(false);
    expect(names(base)).toEqual([]);
  });

  it('the removal is bounded too: the scan finds all four in time, each removal costs 100 ms of a 150 ms budget, and exactly two are removed', () => {
    const base = four();
    let t = 0;
    const report = cleanOrphans({ base, budgetMs: 150, now: () => t, rm: (path, opts) => { rmSync(path, opts); t += 100; }, ...options });
    expect(report.capped).toBe(true);
    expect(report.removed).toHaveLength(2);
    expect(names(base)).toHaveLength(2);
  });

  it('the cleanup a command does first never fails it: a bad scratch root is one warning line', () => {
    const warnings = [];
    expect(cleanOnStart({ base: join(root(), 'does-not-exist'), warn: (m) => warnings.push(m), ...options }).removed).toEqual([]);
    expect(cleanOnStart({ base: root(), now: () => { throw new Error('boom'); }, warn: (m) => warnings.push(m) })).toBe(null);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe('warning: orphaned scratch cleanup skipped: boom');
  });

  it('an entry that cannot be removed is reported as failed, never thrown, and warned about once', () => {
    const base = root();
    const path = tree(base, 'testguard-iiiiii', { pid: DEAD, host: HOST });
    const warnings = [];
    // A directory the tree's parent will not let go of: the tree is a mount-like file the cleanup cannot unlink.
    const report = cleanOnStart({ base, warn: (m) => warnings.push(m), rm: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, ...options });
    expect(report.failed.map((f) => [f.path, f.error])).toEqual([[path, 'EACCES']]);
    expect(report.removed).toEqual([]);
    expect(warnings).toEqual([`warning: could not remove 1 orphaned scratch entry under ${base} (testguard clean reports them)`]);
  });
});

describe('a child scope', () => {
  it('carries an owner record for its directory, dropped with it', () => {
    const base = root();
    const scope = withScratchBase(base, () => childScope());
    const name = scope.env.TMPDIR.slice(scope.env.TMPDIR.lastIndexOf('/') + 1);
    expect(JSON.parse(readFileSync(join(ownersDir(base), `${name}.json`), 'utf8'))).toMatchObject({ pid: process.pid });
    scope.dispose();
    expect(readdirSync(ownersDir(base))).toEqual([]);
  });
});
