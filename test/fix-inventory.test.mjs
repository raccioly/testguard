import { afterEach, describe, expect, it, vi } from 'vitest';
import * as child from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readFixCommitInventory } from '../src/scaffold/fix-input.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

vi.mock('node:child_process', async original => ({ ...await original() }));
vi.mock('node:perf_hooks', async original => { const actual = await original(); return { ...actual, performance: { now: () => actual.performance.now() } }; });
const roots = [];
function fixture(format = 'sha1') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'testguard-fix-inventory-'))); roots.push(root);
  const git = (...args) => {
    const run = child.spawnSync('git', [...FIXTURE_GIT, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', `core.hooksPath=${devNull}`, ...args], { cwd: root, encoding: 'utf8', timeout: 5000 });
    if (run.status !== 0) throw new Error(run.stderr); return run.stdout.trim();
  };
  git('init', '-q', `--object-format=${format}`); mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested/testguard.claims.json'), 'untrusted marker');
  writeFileSync(join(root, 'nested/guard.py'), 'x = 1'); writeFileSync(join(root, 'guard.mjs'), 'export const x = 1;');
  git('add', '.'); git('commit', '-qm', 'Before'); const parent = git('rev-parse', 'HEAD');
  unlinkSync(join(root, 'nested/testguard.claims.json'));
  writeFileSync(join(root, 'nested/guard.py'), 'x = 2'); writeFileSync(join(root, 'guard.mjs'), 'export const x = 2;');
  git('add', '-A'); git('commit', '-qm', 'Selected fix');
  return { root, git, parent, commit: git('rev-parse', 'HEAD') };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('offline root-scoped fix inventory', () => {
  it.each(['sha1', 'sha256'])('binds actual %s history and historical delegation without changing dirty work', format => {
    const f = fixture(format); writeFileSync(join(f.root, 'guard.mjs'), 'Unrelated dirty source');
    const index = readFileSync(join(f.root, '.git/index')), status = f.git('status', '--porcelain');
    const result = readFixCommitInventory({ projectDir: f.root, commit: f.commit });
    expect(result.commit).toBe(f.commit); expect(result.parent).toBe(f.parent); expect(result.subject).toBe('Selected fix');
    expect(result.counts).toEqual({ total: 3, supported: 1, deleted: 0, unsupported: 0, excluded: 2 });
    expect(result.paths.map(r => r.file)).toEqual(['guard.mjs']); expect(result.paths[0].newId).toHaveLength(f.commit.length);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.paths)).toBe(true);
    expect(result.claims).toBeUndefined(); expect(result.source).toBeUndefined(); expect(JSON.stringify(result)).not.toContain('nested');
    expect(f.git('rev-parse', 'HEAD')).toBe(f.commit); expect(f.git('status', '--porcelain')).toBe(status);
    expect(readFileSync(join(f.root, '.git/index'))).toEqual(index); expect(readFileSync(join(f.root, 'guard.mjs'), 'utf8')).toBe('Unrelated dirty source');
  });
  it('refuses nested directory selections rather than expanding to the parent repository', () => {
    const f = fixture(); expect(() => readFixCommitInventory({ projectDir: join(f.root, 'nested'), commit: f.commit })).toThrow(/project-root-required/);
  });
  it('accepts a linked worktree with its own exact root', () => {
    const f = fixture(); const linked = join(f.root, 'linked'); f.git('worktree', 'add', '--detach', linked, f.commit);
    expect(readFixCommitInventory({ projectDir: linked, commit: f.commit }).counts.excluded).toBe(2);
  });
  it('partitions actual private, deleted, symlink, gitlink and rename delete/add records', () => {
    const f = fixture(); mkdirSync(join(f.root, '.wolf'));
    writeFileSync(join(f.root, '.wolf/secret.mjs'), 'neutral private fixture');
    symlinkSync('guard.mjs', join(f.root, 'alias.mjs')); unlinkSync(join(f.root, 'guard.mjs'));
    renameSync(join(f.root, 'nested/guard.py'), join(f.root, 'renamed.py'));
    f.git('add', '-A'); f.git('update-index', '--add', '--cacheinfo', `160000,${f.commit},linked-project`);
    f.git('commit', '-qm', 'Boundary partitions'); const commit = f.git('rev-parse', 'HEAD');
    const result = readFixCommitInventory({ projectDir: f.root, commit });
    expect(result.counts).toEqual({ total: 6, supported: 1, deleted: 2, unsupported: 2, excluded: 1 });
    expect(result.paths.map(r => [r.file, r.status, r.disposition])).toEqual([
      ['alias.mjs', 'A', 'unsupported'], ['guard.mjs', 'D', 'deleted'], ['linked-project', 'A', 'unsupported'],
      ['nested/guard.py', 'D', 'deleted'], ['renamed.py', 'A', 'supported'],
    ]);
    expect(JSON.stringify(result)).not.toContain('.wolf'); expect(result.paths.every(Object.isFrozen)).toBe(true);
  });
  it('admits a real empty historical diff without inventing candidates', () => {
    const f = fixture(); f.git('commit', '--allow-empty', '-qm', 'No changed paths'); const commit = f.git('rev-parse', 'HEAD');
    const result = readFixCommitInventory({ projectDir: f.root, commit });
    expect(result.paths).toEqual([]); expect(result.counts).toEqual({ total: 0, supported: 0, deleted: 0, unsupported: 0, excluded: 0 });
  });
  it('refuses bare repositories and directly symlinked project roots', () => {
    const f = fixture(); const bare = join(f.root, 'bare.git'), alias = join(f.root, 'alias');
    f.git('clone', '--bare', f.root, bare); symlinkSync(f.root, alias);
    expect(() => readFixCommitInventory({ projectDir: bare, commit: f.commit })).toThrow(/object-read-unavailable/);
    expect(() => readFixCommitInventory({ projectDir: alias, commit: f.commit })).toThrow(/unsafe-root/);
  });
  it('uses only supplied immutable IDs and sanitized offline options for all five reads', () => {
    const f = fixture(); const original = child.spawnSync; const calls = [];
    vi.stubEnv('GIT_DIR', '/unavailable'); vi.stubEnv('GIT_CONFIG_COUNT', '1'); vi.stubEnv('GIT_CONFIG_KEY_0', 'core.fsmonitor'); vi.stubEnv('GIT_CONFIG_VALUE_0', 'untrusted-command');
    vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => { calls.push({ args, options }); return original(command, args, options); });
    expect(readFixCommitInventory({ projectDir: f.root, commit: f.commit }).counts.total).toBe(3);
    expect(calls).toHaveLength(5);
    for (const { args, options } of calls) {
      expect(args).toContain('--no-lazy-fetch'); expect(args).toContain('--no-replace-objects'); expect(args).toContain('core.fsmonitor=false'); expect(args).toContain(`core.hooksPath=${devNull}`);
      expect(options.env.GIT_DIR).toBeUndefined(); expect(options.env.GIT_CONFIG_COUNT).toBeUndefined(); expect(options.env.GIT_CONFIG_VALUE_0).toBeUndefined();
      expect(options.env.GIT_CONFIG_NOSYSTEM).toBe('1'); expect(options.env.GIT_CONFIG_GLOBAL).toBe(devNull); expect(options.maxBuffer).toBe(128 * 1024);
    }
    expect(calls.filter(c => c.args.includes('ls-tree')).map(c => c.args.at(-1))).toEqual([f.parent, f.commit]);
    expect(calls.at(-1).args.slice(-3)).toEqual([f.parent, f.commit, '--']);
    expect(calls.at(-1).args).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv', '--no-renames']));
  });
  it('shares shrinking timeouts across every offline command and refuses exhausted continuation', () => {
    const f = fixture(); const original = child.spawnSync; const timeouts = []; let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => {
      timeouts.push(options.timeout); expect(args).toContain('--no-lazy-fetch'); expect(args).toContain('--no-replace-objects');
      expect(options.shell).toBe(false); expect(options.env.GIT_CONFIG_GLOBAL).toBe(devNull);
      const result = original(command, args, options); clock += 1000; return result;
    });
    expect(() => readFixCommitInventory({ projectDir: f.root, commit: f.commit })).toThrow(/deadline|object-read-unavailable/);
    expect(timeouts).toEqual([5000, 4000, 3000, 2000, 1000]);
  });
  it.each(['ls-tree', 'diff-tree'])('refuses %s process failures without an empty fallback', failing => {
    const f = fixture(); const original = child.spawnSync;
    vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => args.includes(failing) ? { status: 1, stdout: Buffer.alloc(0) } : original(command, args, options));
    expect(() => readFixCommitInventory({ projectDir: f.root, commit: f.commit })).toThrow(/object-read-unavailable/);
  });
  it('refuses truncated marker output before executing the diff', () => {
    const f = fixture(); const original = child.spawnSync; let diff = false;
    vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => {
      if (args.includes('diff-tree')) diff = true;
      return args.includes('ls-tree') ? { status: 0, stdout: Buffer.from('nested/testguard.claims.json') } : original(command, args, options);
    });
    expect(() => readFixCommitInventory({ projectDir: f.root, commit: f.commit })).toThrow(/truncated-output/); expect(diff).toBe(false);
  });
  it('binds raw object width even on excluded paths', () => {
    const f = fixture(); const original = child.spawnSync;
    vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => args.includes('diff-tree') ? { status: 0, stdout: Buffer.from(`:100644 100644 ${'a'.repeat(64)} ${'b'.repeat(64)} M\0nested/guard.py\0`) } : original(command, args, options));
    expect(() => readFixCommitInventory({ projectDir: f.root, commit: f.commit })).toThrow(/object-width-mismatch/);
  });
  it.each(['rev-parse', 'ls-tree', 'diff-tree'])('refuses malformed or over-limit %s output without partial results', target => {
    const f = fixture(); const original = child.spawnSync;
    vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => args.includes(target) ? { status: 0, stdout: Buffer.alloc(128 * 1024 + 1) } : original(command, args, options));
    expect(() => readFixCommitInventory({ projectDir: f.root, commit: f.commit })).toThrow(/object-byte-limit/);
  });
  it('refuses malformed root UTF-8 and incomplete raw diff data', () => {
    const f = fixture(); const original = child.spawnSync;
    const spy = vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => args.includes('rev-parse') ? { status: 0, stdout: Buffer.from([0xff, 10]) } : original(command, args, options));
    expect(() => readFixCommitInventory({ projectDir: f.root, commit: f.commit })).toThrow(/invalid-root-encoding/);
    spy.mockImplementation((command, args, options) => args.includes('diff-tree') ? { status: 0, stdout: Buffer.from('truncated') } : original(command, args, options));
    expect(() => readFixCommitInventory({ projectDir: f.root, commit: f.commit })).toThrow(/truncated-output/);
  });
  it('refuses a replaced actual root immediately after a process completes', () => {
    const f = fixture(); const original = child.spawnSync; const moved = `${f.root}-moved`; roots.push(moved);
    vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => {
      const result = original(command, args, options); renameSync(f.root, moved); mkdirSync(f.root); return result;
    });
    expect(() => readFixCommitInventory({ projectDir: f.root, commit: f.commit })).toThrow(/root-changed/);
  });
  it('refuses elapsed time at final admission even when all commands finished in budget', () => {
    const f = fixture(); let reads = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => ++reads >= 12 ? 5000 : 0);
    expect(() => readFixCommitInventory({ projectDir: f.root, commit: f.commit })).toThrow(/deadline/);
  });
  it('charges captured bytes across metadata, both trees and the diff', () => {
    const f = fixture(); const original = child.spawnSync;
    const object = original('git', ['cat-file', 'commit', f.commit], { cwd: f.root }).stdout;
    const bytes = Buffer.concat([object, Buffer.alloc(128 * 1024 - object.length, 32)]);
    const stored = original('git', ['hash-object', '--literally', '-t', 'commit', '-w', '--stdin'], { cwd: f.root, input: bytes });
    expect(stored.status).toBe(0); const commit = stored.stdout.toString().trim();
    const listing = Buffer.from(Array.from({ length: 4096 }, (_, i) => `${String(i).padStart(31, 'x')}\0`).join(''));
    const header = `:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0`;
    const diff = Buffer.from(Array.from({ length: 256 }, (_, i) => `${header}${String(i).padStart(511 - Buffer.byteLength(header), 'x')}\0`).join(''));
    expect(listing.length).toBe(128 * 1024); expect(diff.length).toBe(128 * 1024);
    vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => args.includes('ls-tree') ? { status: 0, stdout: listing } : args.includes('diff-tree') ? { status: 0, stdout: diff } : original(command, args, options));
    expect(() => readFixCommitInventory({ projectDir: f.root, commit })).toThrow(/aggregate-byte-limit/);
  });
});
