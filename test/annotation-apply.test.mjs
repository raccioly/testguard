import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { applyAnnotationPlacement, planAnnotationPlacement, prepareAnnotationApply } from '../src/claims/annotation-placement.mjs';

const failures = vi.hoisted(() => ({ sync: false, syncs: 0, afterSync: null, write: null }));
vi.mock('node:fs', async (original) => {
  const fs = await original();
  return { ...fs,
    fsyncSync: (...args) => { if (failures.sync) throw new Error('simulated recovery fsync failure'); const result = fs.fsyncSync(...args); failures.afterSync?.(++failures.syncs); return result; },
    writeSync: (...args) => failures.write ? failures.write(fs.writeSync, args) : fs.writeSync(...args),
  };
});

const roots = [], handles = [];
afterEach(() => {
  failures.sync = false;
  failures.syncs = 0; failures.afterSync = null; failures.write = null;
  for (const handle of handles.splice(0)) handle.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const source = 'export function allowed() { return true; }\n';
function project() {
  const projectDir = mkdtempSync(join(tmpdir(), 'tg-annotation-prepare-')); roots.push(projectDir);
  mkdirSync(join(projectDir, 'src'));
  writeFileSync(join(projectDir, 'src/a.mjs'), source);
  const claims = { schemaVersion: 1, claims: [{ id: 'A-1', statement: 'The required result is true.', source: { kind: 'spec' }, severity: 'high', producedBy: { producer: 'human' }, faults: [{ id: 'F1', description: 'Remove the required result.', faultClass: 'other', file: 'src/a.mjs', find: 'return true;', replace: 'return false;', producedBy: { producer: 'human' } }] }] };
  const claimsPath = join(projectDir, 'testguard.claims.json'); writeFileSync(claimsPath, JSON.stringify(claims));
  const plan = planAnnotationPlacement({ projectDir, claims });
  return { projectDir, claimsPath, claims, plan };
}
function prepare(context) {
  const handle = prepareAnnotationApply(context); handles.push(handle); roots.push(handle.recoveryDir); return handle;
}
function apply(context) {
  try { const report = applyAnnotationPlacement(context); roots.push(report.recoveryDir); return report; }
  catch (error) { if (error.recoveryDir) roots.push(error.recoveryDir); throw error; }
}

describe('annotation authoring preparation — no source writes', () => {
  it('returns an immutable independent handle and deeply immutable prepared plan', () => {
    const context = project(); const handle = prepare(context);
    const expected = structuredClone(handle.plan);
    context.plan.files[0].proposed = 'caller-modified source';
    context.plan.selectedClaimIds.push('OTHER-1');
    expect(handle.plan).toEqual(expected);
    expect(Object.isFrozen(context.plan)).toBe(false);
    expect(() => { handle.plan.files[0].proposed = 'changed prepared action'; }).toThrow(TypeError);
    expect(() => { handle.plan.files[0].identity.mode = 0; }).toThrow(TypeError);
    expect(() => { handle.plan.files[0].claimIds.push('OTHER-1'); }).toThrow(TypeError);
    expect(() => { handle.plan.files.splice(0, 1); }).toThrow(TypeError);
    expect(() => { handle.plan.selectedClaimIds.push('OTHER-1'); }).toThrow(TypeError);
    expect(() => { handle.release = () => ({ released: true }); }).toThrow(TypeError);
    expect(() => { handle.recoveryDir = context.projectDir; }).toThrow(TypeError);
    expect(readFileSync(join(context.projectDir, 'src/a.mjs'), 'utf8')).toBe(source);
    expect(handle.release()).toMatchObject({ released: true });
  });

  it('holds an exclusive lock and persists recoverable originals with private permissions', () => {
    const context = project(); const handle = prepare(context);
    expect(handle.ready).toBe(true);
    expect(existsSync(join(context.projectDir, '.testguard-annotations.lock'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(handle.recoveryDir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ state: 'prepared', projectDir: realpathSync(context.projectDir), claimsHash: context.plan.claimsHash });
    expect(manifest.files).toHaveLength(1);
    expect(readFileSync(join(handle.recoveryDir, manifest.files[0].original), 'utf8')).toBe(source);
    expect(lstatSync(handle.recoveryDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(handle.recoveryDir, manifest.files[0].original)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(context.projectDir, 'src/a.mjs'), 'utf8')).toBe(source);
    expect(JSON.parse(readFileSync(context.claimsPath, 'utf8'))).toEqual(context.claims);
    expect(handle.release()).toMatchObject({ released: true });
    expect(handle.release()).toMatchObject({ released: true });
    expect(existsSync(join(context.projectDir, '.testguard-annotations.lock'))).toBe(false);
    expect(existsSync(handle.recoveryDir)).toBe(true);
  });

  it('rejects on-disk claim edits even if the caller retained the old claims object', () => {
    const context = project(); const edited = structuredClone(context.claims); edited.claims[0].statement += ' Changed.';
    writeFileSync(context.claimsPath, JSON.stringify(edited));
    expect(() => prepare(context)).toThrow(/claims-changed/);
    expect(existsSync(join(context.projectDir, '.testguard-annotations.lock'))).toBe(false);
    expect(readFileSync(join(context.projectDir, 'src/a.mjs'), 'utf8')).toBe(source);
  });

  it('does not reclaim another authoring lock or overwrite its contents', () => {
    const context = project(); const first = prepare(context);
    const lock = join(context.projectDir, '.testguard-annotations.lock');
    const before = readFileSync(lock);
    expect(() => prepare(context)).toThrow(/lock.*exists/i);
    expect(readFileSync(lock)).toEqual(before);
    expect(first.release()).toMatchObject({ released: true });
  });

  it.each(['symlink', 'external', 'invalid'])('rejects %s claims without modifying source', (kind) => {
    const context = project();
    if (kind === 'symlink') { writeFileSync(join(context.projectDir, 'actual.json'), JSON.stringify(context.claims)); unlinkSync(context.claimsPath); symlinkSync(join(context.projectDir, 'actual.json'), context.claimsPath); }
    if (kind === 'external') { const external = project(); context.claimsPath = external.claimsPath; }
    if (kind === 'invalid') writeFileSync(context.claimsPath, '{invalid');
    expect(() => prepare(context)).toThrow(/claims|path/);
    expect(existsSync(join(context.projectDir, '.testguard-annotations.lock'))).toBe(false);
    expect(readFileSync(join(context.projectDir, 'src/a.mjs'), 'utf8')).toBe(source);
  });

  it('releases its lock on failed recovery persistence and reports the retained backup directory', () => {
    const context = project(); failures.sync = true;
    let failure;
    try { prepare(context); } catch (error) { failure = error; if (error.recoveryDir) roots.push(error.recoveryDir); }
    expect(failure?.message).toMatch(/simulated recovery fsync failure/);
    expect(failure?.recoveryDir).toBeTruthy();
    expect(existsSync(join(context.projectDir, '.testguard-annotations.lock'))).toBe(false);
    expect(readFileSync(join(context.projectDir, 'src/a.mjs'), 'utf8')).toBe(source);
  });

  it('will not delete a lock replaced by another actor during preparation', () => {
    const context = project(); const handle = prepare(context);
    const lock = join(context.projectDir, '.testguard-annotations.lock');
    unlinkSync(lock); writeFileSync(lock, 'another actor'); chmodSync(lock, 0o600);
    expect(handle.release()).toMatchObject({ released: false, reason: 'lock-changed' });
    expect(readFileSync(lock, 'utf8')).toBe('another actor');
  });

  it('preserves a lock whose bytes changed without an inode replacement', () => {
    const context = project(); const handle = prepare(context);
    const lock = join(context.projectDir, '.testguard-annotations.lock');
    const inode = lstatSync(lock).ino;
    writeFileSync(lock, 'changed ownership');
    expect(lstatSync(lock).ino).toBe(inode);
    expect(handle.release()).toMatchObject({ released: false, reason: 'lock-changed' });
    expect(readFileSync(lock, 'utf8')).toBe('changed ownership');
  });

  it('refuses changed source under the lock and preserves the editor contents', () => {
    const context = project(); const edited = source + '// editor change\n';
    writeFileSync(join(context.projectDir, 'src/a.mjs'), edited);
    expect(() => prepare(context)).toThrow(/plan-changed/);
    expect(readFileSync(join(context.projectDir, 'src/a.mjs'), 'utf8')).toBe(edited);
    expect(existsSync(join(context.projectDir, '.testguard-annotations.lock'))).toBe(false);
  });

  it('persists every selected original before returning a prepared handle', () => {
    const context = project();
    writeFileSync(join(context.projectDir, 'src/b.mjs'), source);
    context.claims.claims[0].faults.push({ ...context.claims.claims[0].faults[0], id: 'F2', file: 'src/b.mjs' });
    writeFileSync(context.claimsPath, JSON.stringify(context.claims));
    context.plan = planAnnotationPlacement(context);
    const handle = prepare(context);
    const manifest = JSON.parse(readFileSync(join(handle.recoveryDir, 'manifest.json'), 'utf8'));
    expect(manifest.files.map((file) => file.file)).toEqual(['src/a.mjs', 'src/b.mjs']);
    for (const file of manifest.files) {
      expect(readFileSync(join(handle.recoveryDir, file.original), 'utf8')).toBe(source);
      expect(readFileSync(join(context.projectDir, file.file), 'utf8')).toBe(source);
    }
  });
});

describe('annotation source writing — recoverable, not atomic', () => {
  it('refuses a checkout-local temporary directory before placing recovery material there', () => {
    const context = project(); const localTemp = join(context.projectDir, 'tmp'); mkdirSync(localTemp);
    const previous = process.env.TMPDIR;
    try {
      process.env.TMPDIR = localTemp;
      expect(() => apply(context)).toThrow(/recovery.*outside.*project/);
      expect(readdirSync(localTemp)).toEqual([]);
      expect(readFileSync(join(context.projectDir, 'src/a.mjs'), 'utf8')).toBe(source);
      expect(existsSync(join(context.projectDir, '.testguard-annotations.lock'))).toBe(false);
    } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
  });

  it('binds a parent alias to the canonical selected root and safely maps its claims path', () => {
    const context = project(); const original = context.projectDir;
    const container = mkdtempSync(join(tmpdir(), 'tg-root-alias-')); roots.push(container);
    symlinkSync(dirname(original), join(container, 'alias'));
    context.projectDir = join(container, 'alias', basename(original));
    context.claimsPath = join(context.projectDir, 'testguard.claims.json');
    context.plan = planAnnotationPlacement(context);
    expect(context.plan.projectDir).toBe(realpathSync(original));
    expect(apply(context)).toMatchObject({ state: 'applied', changed: ['src/a.mjs'] });
    expect(readFileSync(join(original, 'src/a.mjs'), 'utf8')).toBe(context.plan.files[0].proposed);
  });

  it('refuses a custom claims file that is also a selected source target', () => {
    const context = project(); context.claimsPath = join(context.projectDir, 'src/claims.mjs');
    context.claims.claims[0].faults[0] = { ...context.claims.claims[0].faults[0], file: 'src/claims.mjs', find: '"schemaVersion":1', replace: '"schemaVersion":2' };
    writeFileSync(context.claimsPath, JSON.stringify(context.claims));
    context.plan = planAnnotationPlacement(context);
    expect(context.plan.applicable).toBe(true);
    const before = readFileSync(context.claimsPath);
    expect(() => apply(context)).toThrow(/claims file.*target/);
    expect(readFileSync(context.claimsPath)).toEqual(before);
    expect(existsSync(join(context.projectDir, '.testguard-annotations.lock'))).toBe(false);
  });
  it('writes only the previewed headers, preserves permissions and claims, and is idempotent', () => {
    const context = project(); const path = join(context.projectDir, 'src/a.mjs'); chmodSync(path, 0o640);
    context.plan = planAnnotationPlacement(context);
    const beforeClaims = readFileSync(context.claimsPath);
    const inode = lstatSync(path).ino;
    const report = apply(context);
    expect(report).toMatchObject({ state: 'applied', changed: ['src/a.mjs'], touched: ['src/a.mjs'], failed: [], lockRelease: { released: true } });
    expect(readFileSync(path, 'utf8')).toBe(context.plan.files[0].proposed);
    expect(lstatSync(path).ino).toBe(inode);
    expect(lstatSync(path).mode & 0o777).toBe(0o640);
    expect(readFileSync(context.claimsPath)).toEqual(beforeClaims);
    expect(readFileSync(join(report.recoveryDir, '0.original'), 'utf8')).toBe(source);
    expect(JSON.parse(readFileSync(join(report.recoveryDir, 'result.json'), 'utf8'))).toEqual(report);
    context.plan = planAnnotationPlacement(context);
    expect(apply(context)).toMatchObject({ state: 'applied', changed: [], touched: [], unchanged: ['src/a.mjs'] });
  });

  it.each(['claims', 'source', 'lock'])('refuses %s drift after recovery preparation without touching source', (kind) => {
    const context = project(); const path = join(context.projectDir, 'src/a.mjs'); const editor = source + '// editor\n';
    failures.afterSync = (count) => {
      if (count !== 2) return;
      if (kind === 'claims') { const edited = structuredClone(context.claims); edited.claims[0].statement += ' Changed.'; writeFileSync(context.claimsPath, JSON.stringify(edited)); }
      if (kind === 'source') writeFileSync(path, editor);
      if (kind === 'lock') writeFileSync(join(context.projectDir, '.testguard-annotations.lock'), 'another actor');
    };
    const report = apply(context);
    expect(report).toMatchObject({ state: 'refused', touched: [], changed: [] });
    expect(report.failed).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toBe(kind === 'source' ? editor : source);
    if (kind === 'lock') expect(readFileSync(join(context.projectDir, '.testguard-annotations.lock'), 'utf8')).toBe('another actor');
    else expect(report.lockRelease.released).toBe(true);
  });

  it('rechecks a target after the started journal and before descriptor writes', () => {
    const context = project(); const path = join(context.projectDir, 'src/a.mjs'); const editor = source + '// late edit\n';
    failures.afterSync = (count) => { if (count === 3) writeFileSync(path, editor); };
    const report = apply(context);
    expect(report).toMatchObject({ state: 'refused', changed: [], touched: [] });
    expect(readFileSync(path, 'utf8')).toBe(editor);
    expect(report.failed[0]).toMatchObject({ file: 'src/a.mjs', stage: 'target-preflight' });
  });

  it('reloads claims after the started journal and before each source write', () => {
    const context = project();
    failures.afterSync = (count) => {
      if (count !== 3) return;
      const edited = structuredClone(context.claims); edited.claims[0].statement += ' Late change.';
      writeFileSync(context.claimsPath, JSON.stringify(edited));
    };
    const report = apply(context);
    expect(report).toMatchObject({ state: 'refused', changed: [], touched: [] });
    expect(readFileSync(join(context.projectDir, 'src/a.mjs'), 'utf8')).toBe(source);
  });

  it('replays the entire selection after preparation before writing any first target', () => {
    const context = project(); const later = join(context.projectDir, 'src/b.mjs'); const editor = source + '// editor before any write\n';
    writeFileSync(later, source);
    context.claims.claims[0].faults.push({ ...context.claims.claims[0].faults[0], id: 'F2', file: 'src/b.mjs' });
    writeFileSync(context.claimsPath, JSON.stringify(context.claims)); context.plan = planAnnotationPlacement(context);
    failures.afterSync = (count) => { if (count === 3) writeFileSync(later, editor); };
    const report = apply(context);
    expect(report).toMatchObject({ state: 'refused', changed: [], touched: [] });
    expect(readFileSync(join(context.projectDir, 'src/a.mjs'), 'utf8')).toBe(source);
    expect(readFileSync(later, 'utf8')).toBe(editor);
  });

  it('reports a partially written file and retains originals without automatic rollback', () => {
    const context = project(); let writes = 0;
    failures.write = (write, args) => {
      if (++writes === 1) return write(args[0], args[1], args[2], 1, args[4]);
      throw new Error('simulated source write failure');
    };
    const report = apply(context);
    expect(report).toMatchObject({ state: 'partial', changed: [], touched: ['src/a.mjs'], lockRelease: { released: true } });
    expect(report.failed[0]).toMatchObject({ file: 'src/a.mjs', stage: 'source-write' });
    expect(readFileSync(join(context.projectDir, 'src/a.mjs'), 'utf8')).toBe('/' + source.slice(1));
    expect(readFileSync(join(report.recoveryDir, '0.original'), 'utf8')).toBe(source);
    expect(existsSync(join(report.recoveryDir, 'started.json'))).toBe(true);
  });

  it('keeps the first completed file and a later editor change on a multi-file failure', () => {
    const context = project(); const later = join(context.projectDir, 'src/b.mjs'); const editor = source + '// later editor\n';
    writeFileSync(later, source);
    context.claims.claims[0].faults.push({ ...context.claims.claims[0].faults[0], id: 'F2', file: 'src/b.mjs' });
    writeFileSync(context.claimsPath, JSON.stringify(context.claims));
    context.plan = planAnnotationPlacement(context);
    failures.afterSync = (count) => { if (count === 5) writeFileSync(later, editor); };
    const report = apply(context);
    expect(report).toMatchObject({ state: 'partial', changed: ['src/a.mjs'], touched: ['src/a.mjs'] });
    expect(report.failed[0]).toMatchObject({ file: 'src/b.mjs', stage: 'target-preflight' });
    expect(readFileSync(join(context.projectDir, 'src/a.mjs'), 'utf8')).toBe(context.plan.files[0].proposed);
    expect(readFileSync(later, 'utf8')).toBe(editor);
    expect(readFileSync(join(report.recoveryDir, '1.original'), 'utf8')).toBe(source);
  });

  it('does not report success when completion journals fail after a verified source write', () => {
    const context = project();
    failures.afterSync = (count) => { if (count === 4) failures.sync = true; };
    const report = apply(context);
    expect(report).toMatchObject({ state: 'partial', changed: ['src/a.mjs'], touched: ['src/a.mjs'] });
    expect(report.failed.map((failure) => failure.stage)).toEqual(['completion-journal', 'result-journal']);
    expect(readFileSync(join(context.projectDir, 'src/a.mjs'), 'utf8')).toBe(context.plan.files[0].proposed);
    expect(readFileSync(join(report.recoveryDir, '0.original'), 'utf8')).toBe(source);
  });

  it('never publishes a final applied journal when its own sync fails', () => {
    const context = project();
    failures.afterSync = (count) => { if (count === 5) failures.sync = true; };
    const report = apply(context);
    expect(report).toMatchObject({ state: 'partial', changed: ['src/a.mjs'], touched: ['src/a.mjs'] });
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({ stage: 'result-journal' });
    expect(existsSync(join(report.recoveryDir, 'result.json'))).toBe(false);
    expect(existsSync(join(report.recoveryDir, 'result.pending.json'))).toBe(true);
    expect(readFileSync(join(report.recoveryDir, '0.original'), 'utf8')).toBe(source);
  });

  it('detects an external edit during source sync instead of declaring a verified apply', () => {
    const context = project(); const path = join(context.projectDir, 'src/a.mjs'); const editor = '// external editor\n' + source;
    failures.afterSync = (count) => { if (count === 4) writeFileSync(path, editor); };
    const report = apply(context);
    expect(report).toMatchObject({ state: 'partial', changed: [], touched: ['src/a.mjs'] });
    expect(report.failed[0]).toMatchObject({ file: 'src/a.mjs', stage: 'write-verification' });
    expect(readFileSync(path, 'utf8')).toBe(editor);
  });

  it('refuses a late target symlink without writing its destination', () => {
    const context = project(); const path = join(context.projectDir, 'src/a.mjs'); const destination = join(context.projectDir, 'src/external.mjs');
    writeFileSync(destination, source);
    failures.afterSync = (count) => { if (count === 3) { unlinkSync(path); symlinkSync(destination, path); } };
    const report = apply(context);
    expect(report).toMatchObject({ state: 'refused', changed: [], touched: [] });
    expect(report.failed[0]).toMatchObject({ file: 'src/a.mjs', stage: 'target-preflight' });
    expect(readFileSync(destination, 'utf8')).toBe(source);
  });
});
