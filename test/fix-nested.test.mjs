import { afterEach, describe, expect, it, vi } from 'vitest';
import * as child from 'node:child_process';
import * as admission from '../src/scaffold/admission.mjs';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync, rmSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import { readFixCommitInventory, readNestedFixCommitInventory } from '../src/scaffold/fix-input.mjs';

vi.mock('node:child_process', async original => ({ ...await original() }));
vi.mock('../src/scaffold/admission.mjs', async original => ({ ...await original() }));
const roots = [], markerBytes = '{"schemaVersion":1,"claims":[]}';
function fixture(prefix = 'packages/widget', format = 'sha1') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'testguard-fix-nested-'))); roots.push(root);
  const git = (...args) => {
    const run = child.spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', `core.hooksPath=${devNull}`, ...args], { cwd: root, encoding: 'utf8', timeout: 5000 });
    if (run.status !== 0) throw new Error(run.stderr); return run.stdout.trim();
  };
  git('init', '-q', `--object-format=${format}`);
  const project = join(root, prefix), sibling = join(root, `${prefix}-other`);
  mkdirSync(join(project, 'child'), { recursive: true }); mkdirSync(sibling);
  writeFileSync(join(root, 'testguard.claims.json'), markerBytes); writeFileSync(join(root, 'packages/testguard.claims.json'), markerBytes);
  writeFileSync(join(project, 'testguard.claims.json'), markerBytes); writeFileSync(join(project, 'child/testguard.claims.json'), markerBytes);
  writeFileSync(join(sibling, 'testguard.claims.json'), markerBytes);
  writeFileSync(join(project, 'guard.mjs'), 'export const x = 1;'); writeFileSync(join(project, 'child/guard.py'), 'x = 1'); writeFileSync(join(sibling, 'guard.mjs'), 'export const x = 1;');
  git('add', '.'); git('commit', '-qm', 'Before'); const parent = git('rev-parse', 'HEAD');
  unlinkSync(join(project, 'child/testguard.claims.json'));
  writeFileSync(join(project, 'guard.mjs'), 'export const x = 2;'); writeFileSync(join(project, 'child/guard.py'), 'x = 2'); writeFileSync(join(sibling, 'guard.mjs'), 'export const x = 2;');
  git('add', '-A'); git('commit', '-qm', 'Scoped fix');
  return { root, project, prefix, git, parent, commit: git('rev-parse', 'HEAD'), marker: join(project, 'testguard.claims.json') };
}
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('explicit nested historical fix scope', () => {
  it.each(['sha1', 'sha256'])('binds actual %s nested history, not ancestor or sibling ownership', format => {
    const f = fixture('packages/widget', format); const index = readFileSync(join(f.root, '.git/index'));
    writeFileSync(join(f.project, 'guard.mjs'), 'Unrelated dirty source'); const status = f.git('status', '--porcelain');
    const result = readNestedFixCommitInventory({ projectDir: f.project, commit: f.commit });
    expect(result.commit).toBe(f.commit); expect(result.parent).toBe(f.parent);
    expect(result.counts).toEqual({ total: 3, supported: 1, deleted: 0, unsupported: 0, excluded: 2 });
    expect(result.paths.map(r => r.file)).toEqual(['guard.mjs']); expect(result.paths[0].newId).toHaveLength(f.commit.length);
    expect(JSON.stringify(result)).not.toContain('packages'); expect(result.claims).toBeUndefined(); expect(Object.isFrozen(result)).toBe(true);
    expect(f.git('status', '--porcelain')).toBe(status); expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
    expect(readFileSync(join(f.project, 'guard.mjs'), 'utf8')).toBe('Unrelated dirty source');
    expect(() => readFixCommitInventory({ projectDir: f.project, commit: f.commit })).toThrow(/project-root-required/);
  });
  it('uses a literal metacharacter prefix rather than a Git glob or implicit scope', () => {
    const f = fixture('packages/widget[1]'); const original = child.spawnSync; let args;
    vi.spyOn(child, 'spawnSync').mockImplementation((command, input, options) => { if (input.includes('diff-tree')) args = input; return original(command, input, options); });
    expect(readNestedFixCommitInventory({ projectDir: f.project, commit: f.commit }).counts.total).toBe(3);
    expect(args.slice(-4)).toEqual([f.parent, f.commit, '--', ':(top,literal)packages/widget[1]/']);
  });
  it('refuses root mode, absent markers and nonconforming markers', () => {
    const f = fixture(); expect(() => readNestedFixCommitInventory({ projectDir: f.root, commit: f.commit })).toThrow(/nested-project-required/);
    unlinkSync(f.marker); expect(() => readNestedFixCommitInventory({ projectDir: f.project, commit: f.commit })).toThrow(/ENOENT/);
    writeFileSync(f.marker, '{}'); expect(() => readNestedFixCommitInventory({ projectDir: f.project, commit: f.commit })).toThrow(/claims|schema|valid/i);
  });
  it('does not execute historical reads before admitting the selected marker', () => {
    const f = fixture(); unlinkSync(f.marker); const original = child.spawnSync; const reads = [];
    vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => { reads.push(args); return original(command, args, options); });
    expect(() => readNestedFixCommitInventory({ projectDir: f.project, commit: f.commit })).toThrow(/ENOENT/);
    expect(reads).toHaveLength(1); expect(reads[0]).toContain('rev-parse');
  });
  it('refuses returned paths outside the selected prefix instead of hiding them', () => {
    const f = fixture(); const original = child.spawnSync;
    vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => args.includes('diff-tree') ? { status: 0, stdout: Buffer.from(`:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0foreign/guard.mjs\0`) } : original(command, args, options));
    expect(() => readNestedFixCommitInventory({ projectDir: f.project, commit: f.commit })).toThrow(/out-of-scope-path/);
  });
  it('refuses current marker drift after historical execution', () => {
    const f = fixture(); const original = child.spawnSync;
    vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => {
      const result = original(command, args, options); if (args.includes('diff-tree')) writeFileSync(f.marker, `${markerBytes}\n`); return result;
    });
    expect(() => readNestedFixCommitInventory({ projectDir: f.project, commit: f.commit })).toThrow(/project-marker-changed/);
    expect(readFileSync(f.marker, 'utf8')).toBe(`${markerBytes}\n`);
  });
  it('refuses same-byte marker substitution rather than treating the hash as identity', () => {
    const f = fixture(); const original = child.spawnSync;
    const replacement = join(f.project, 'replacement.json'); writeFileSync(replacement, markerBytes);
    vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => {
      const result = original(command, args, options); if (args.includes('diff-tree')) renameSync(replacement, f.marker); return result;
    });
    expect(() => readNestedFixCommitInventory({ projectDir: f.project, commit: f.commit })).toThrow(/project-marker-changed/);
    expect(readFileSync(f.marker, 'utf8')).toBe(markerBytes);
  });
  it('compares exact marker bytes even when reported identity fields agree', () => {
    const f = fixture(); const originalSpawn = child.spawnSync, originalAdmission = admission.admitIntentProject;
    let initial;
    vi.spyOn(admission, 'admitIntentProject').mockImplementation(options => {
      const current = originalAdmission(options);
      if (!initial) { initial = current; return current; }
      // Isolate byte binding from metadata drift; real admission still reads and validates changed bytes.
      return { ...current, marker: { ...current.marker, identity: initial.marker.identity } };
    });
    vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => {
      const result = originalSpawn(command, args, options); if (args.includes('diff-tree')) writeFileSync(f.marker, `${markerBytes}\n`); return result;
    });
    expect(() => readNestedFixCommitInventory({ projectDir: f.project, commit: f.commit })).toThrow(/project-marker-changed/);
    expect(readFileSync(f.marker, 'utf8')).toBe(`${markerBytes}\n`);
  });
  it('refuses private selected namespaces before reading history or marker contents', () => {
    const f = fixture('packages/.wolf/widget'); const original = child.spawnSync; const reads = [];
    vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => { reads.push(args); return original(command, args, options); });
    expect(() => readNestedFixCommitInventory({ projectDir: f.project, commit: f.commit })).toThrow(/excluded-project/);
    expect(reads).toHaveLength(1); expect(reads[0]).toContain('rev-parse');
  });
});
