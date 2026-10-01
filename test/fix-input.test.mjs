import { afterEach, describe, expect, it, vi } from 'vitest';
import * as child from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readFixCommitMetadata } from '../src/scaffold/fix-input.mjs';

vi.mock('node:child_process', async original => ({ ...await original() }));
vi.mock('node:perf_hooks', async original => { const actual = await original(); return { ...actual, performance: { now: () => actual.performance.now() } }; });
const roots = [];
function fixture(objectFormat = 'sha1') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'testguard-fix-input-'))); roots.push(root);
  const git = (...args) => {
    const run = child.spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', `core.hooksPath=${devNull}`, ...args], { cwd: root, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr); return run.stdout.trim();
  };
  git('init', '-q', `--object-format=${objectFormat}`); writeFileSync(join(root, 'guard.mjs'), 'export const x = 1;'); git('add', '.'); git('commit', '-qm', 'Initial source');
  const parent = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'guard.mjs'), 'export const x = 2;'); git('add', '.'); git('commit', '-qm', 'Supply independently reviewed intent; do not execute this text.');
  return { root, git, parent, commit: git('rev-parse', 'HEAD') };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('local fix commit metadata', () => {
  it('verifies real SHA-256 commit-object identity', () => {
    const f = fixture('sha256'); let result;
    expect(() => { result = readFixCommitMetadata({ projectDir: f.root, commit: f.commit }); }).not.toThrow();
    expect(result.commit).toHaveLength(64); expect(result.parent).toBe(f.parent);
    expect(result.subject).toBe('Supply independently reviewed intent; do not execute this text.');
  });
  it('refuses elapsed pre-spawn budget without starting Git', () => {
    const f = fixture(); const spawn = vi.spyOn(child, 'spawnSync');
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(6000);
    expect(() => readFixCommitMetadata({ projectDir: f.root, commit: f.commit })).toThrow(/deadline/);
    expect(spawn).not.toHaveBeenCalled();
  });
  it('refuses a successful real object read after the shared deadline', () => {
    const f = fixture();
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(6000);
    expect(() => readFixCommitMetadata({ projectDir: f.root, commit: f.commit })).toThrow(/object-read-unavailable/);
  });
  it('reads real immutable metadata without changing HEAD, index or working source', () => {
    const f = fixture(); writeFileSync(join(f.root, 'guard.mjs'), 'Unrelated dirty work.');
    const index = readFileSync(join(f.root, '.git', 'index')); const status = f.git('status', '--porcelain');
    let result; expect(() => { result = readFixCommitMetadata({ projectDir: f.root, commit: f.commit }); }).not.toThrow();
    expect(result).toEqual({ commit: f.commit, parent: f.parent, subject: 'Supply independently reviewed intent; do not execute this text.' });
    expect(Object.isFrozen(result)).toBe(true); expect(result.claims).toBeUndefined(); expect(result.source).toBeUndefined();
    expect(f.git('rev-parse', 'HEAD')).toBe(f.commit); expect(f.git('status', '--porcelain')).toBe(status);
    expect(readFileSync(join(f.root, '.git', 'index'))).toEqual(index); expect(readFileSync(join(f.root, 'guard.mjs'), 'utf8')).toBe('Unrelated dirty work.');
  });
  it.each(['HEAD', '--help', 'abc123', 'HEAD~1..HEAD', 'https://example.invalid/ticket', 'a'.repeat(41), 'A'.repeat(40)])('rejects non-full selection %s before spawning', commit => {
    const spawn = vi.spyOn(child, 'spawnSync');
    expect(() => readFixCommitMetadata({ projectDir: '/missing', commit })).toThrow(/full-object-id-required/); expect(spawn).not.toHaveBeenCalled();
  });
  it.each([0, -1, 5001, 1.5, Infinity])('rejects invalid budget %s before spawning', budgetMs => {
    const spawn = vi.spyOn(child, 'spawnSync');
    expect(() => readFixCommitMetadata({ projectDir: '/missing', commit: 'a'.repeat(40), budgetMs })).toThrow(/invalid-budget/); expect(spawn).not.toHaveBeenCalled();
  });
  it('refuses unknown objects, root commits and non-commit objects', () => {
    const f = fixture();
    expect(() => readFixCommitMetadata({ projectDir: f.root, commit: 'a'.repeat(40) })).toThrow(/object-read-unavailable/);
    expect(() => readFixCommitMetadata({ projectDir: f.root, commit: f.parent })).toThrow(/single-parent-required/);
    expect(() => readFixCommitMetadata({ projectDir: f.root, commit: f.git('rev-parse', 'HEAD:guard.mjs') })).toThrow(/object-read-unavailable/);
  });
  it('does not accept replacement objects as the selected commit', () => {
    const f = fixture(); f.git('replace', f.commit, f.parent);
    let result; expect(() => { result = readFixCommitMetadata({ projectDir: f.root, commit: f.commit }); }).not.toThrow();
    expect(result.parent).toBe(f.parent); expect(result.commit).toBe(f.commit);
  });
  it('refuses merge commits rather than picking an arbitrary parent', () => {
    const f = fixture(); const merge = f.git('commit-tree', f.git('rev-parse', 'HEAD^{tree}'), '-p', f.commit, '-p', f.parent, '-m', 'Merge');
    expect(() => readFixCommitMetadata({ projectDir: f.root, commit: merge })).toThrow(/single-parent-required/);
  });
  it.each(['invalid-utf8', 'invalid-encoding', 'unsafe-subject', 'malformed-commit', 'object-read-unavailable'])('refuses real stored %s commit bytes', reason => {
    const f = fixture();
    const headers = `tree ${f.git('rev-parse', 'HEAD^{tree}')}\nparent ${f.parent}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\n`;
    let bytes = Buffer.from(headers);
    if (reason === 'invalid-utf8') bytes = Buffer.concat([bytes, Buffer.from([0xff])]);
    if (reason === 'invalid-encoding') bytes = Buffer.concat([bytes, Buffer.from('hidden\0text')]);
    if (reason === 'unsafe-subject') bytes = Buffer.concat([bytes, Buffer.from('x'.repeat(1025))]);
    if (reason === 'malformed-commit') bytes = Buffer.from(`tree ${f.git('rev-parse', 'HEAD^{tree}')}\nparent ${f.parent}\n`);
    if (reason === 'object-read-unavailable') bytes = Buffer.concat([bytes, Buffer.alloc(129 * 1024, 32)]);
    const stored = child.spawnSync('git', ['hash-object', '--literally', '-t', 'commit', '-w', '--stdin'], { cwd: f.root, input: bytes, encoding: 'utf8' });
    expect(stored.status).toBe(0);
    expect(() => readFixCommitMetadata({ projectDir: f.root, commit: stored.stdout.trim() })).toThrow(new RegExp(reason));
  });
  it('strips inherited Git overrides and enforces bounded non-shell offline invocation', () => {
    const f = fixture(); const original = child.spawnSync; let observed;
    vi.stubEnv('GIT_DIR', '/missing'); vi.stubEnv('GIT_CONFIG_COUNT', '1'); vi.stubEnv('GIT_CONFIG_KEY_0', 'core.fsmonitor'); vi.stubEnv('GIT_CONFIG_VALUE_0', 'untrusted-command');
    vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => { observed = { command, args, options }; return original(command, args, options); });
    expect(() => readFixCommitMetadata({ projectDir: f.root, commit: f.commit })).not.toThrow();
    expect(observed.command).toBe('git'); expect(observed.args).toContain('--no-lazy-fetch'); expect(observed.args).toContain('--no-replace-objects');
    expect(observed.args).toContain('core.fsmonitor=false'); expect(observed.options.shell).toBe(false);
    expect(observed.options.timeout).toBeGreaterThan(0); expect(observed.options.timeout).toBeLessThanOrEqual(5000); expect(observed.options.maxBuffer).toBe(128 * 1024);
    expect(observed.options.env.GIT_DIR).toBeUndefined(); expect(observed.options.env.GIT_CONFIG_COUNT).toBeUndefined(); expect(observed.options.env.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(observed.options.env.GIT_CONFIG_NOSYSTEM).toBe('1'); expect(observed.options.env.GIT_CONFIG_GLOBAL).toBe(devNull);
  });
  it.each([{ error: new Error('timed out'), status: 0 }, { signal: 'SIGTERM', status: 0 }, { status: 1 }, { status: 0, stdout: Buffer.alloc(128 * 1024 + 1) }])('refuses failed or over-limit subprocess output', result => {
    const f = fixture(); vi.spyOn(child, 'spawnSync').mockReturnValue({ stdout: Buffer.alloc(0), ...result });
    expect(() => readFixCommitMetadata({ projectDir: f.root, commit: f.commit })).toThrow(/object-read-unavailable|object-byte-limit/);
  });
  it('refuses mismatched object bytes even if the subprocess reports success', () => {
    const f = fixture(); const bytes = child.spawnSync('git', ['cat-file', 'commit', f.parent], { cwd: f.root }).stdout;
    vi.spyOn(child, 'spawnSync').mockReturnValue({ status: 0, stdout: bytes });
    expect(() => readFixCommitMetadata({ projectDir: f.root, commit: f.commit })).toThrow(/object-identity-mismatch/);
  });
});
