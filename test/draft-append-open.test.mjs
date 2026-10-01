import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planDraftAppend } from '../src/scaffold/plan-append.mjs';
import { openDraftAppend } from '../src/scaffold/open-append.mjs';

vi.mock('node:fs', async (original) => ({ ...await original() }));
const roots = [], recovery = [], handles = [];
const doc = { schemaVersion: 1, claims: [{ id: 'INTENT-001', statement: 'Absent input is rejected.', severity: 'high', source: { kind: 'incident' }, producedBy: { producer: 'human' }, faults: [{ id: 'F1', description: 'Drop guard.', file: 'old.mjs', find: 'if (!x)', replace: 'if (false)', faultClass: 'condition-forced', producedBy: { producer: 'agent' } }] }] };
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'testguard-append-open-'))); roots.push(root);
  const draft = join(root, 'draft.json'), source = join(root, 'guard.mjs');
  fs.writeFileSync(draft, JSON.stringify(doc)); fs.writeFileSync(source, 'export function guard(x) {\n  if (!x) throw new Error("absent");\n}\n');
  const request = { projectDir: root, draftPath: 'draft.json', files: ['guard.mjs'], claimId: 'INTENT-001' };
  return { request, plan: planDraftAppend(request), draft, source };
}
function acquire(args) {
  let result; expect(() => { result = openDraftAppend(args); }).not.toThrow();
  handles.push(result); if (result.recoveryDir) recovery.push(result.recoveryDir); return result;
}
function refused(args) {
  let error;
  try { const h = openDraftAppend(args); handles.push(h); if (h.recoveryDir) recovery.push(h.recoveryDir); }
  catch (caught) { error = caught; if (error.recoveryDir) recovery.push(error.recoveryDir); }
  expect(error).toBeDefined(); return error;
}
afterEach(() => { vi.restoreAllMocks(); handles.splice(0).forEach(h => h.release()); recovery.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });

describe('draft append write-descriptor admission', () => {
  it('opens the original without truncation and rechecks the owned current plan', () => {
    const args = fixture(), bytes = fs.readFileSync(args.draft), handle = acquire(args);
    expect(handle.fd).toBeTypeOf('number'); expect(fs.fstatSync(handle.fd).ino).toBe(args.plan.draft.identity.ino);
    expect(fs.readFileSync(args.draft)).toEqual(bytes); expect(() => handle.assertCurrent()).not.toThrow();
    expect(Object.isFrozen(handle)).toBe(true); expect(handle.release()).toEqual({ released: true });
    expect(() => handle.assertCurrent()).toThrow(/closed/); expect(handle.release()).toEqual({ released: true });
  });
  it('refuses source changes made during recovery before opening a write descriptor', () => {
    const args = fixture(), originalSync = fs.fsyncSync, originalOpen = fs.openSync; let count = 0, writes = 0;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { originalSync(fd); if (++count === 2) fs.writeFileSync(args.source, 'export const changed = true;'); });
    vi.spyOn(fs, 'openSync').mockImplementation((path, flags, ...rest) => { if (path === args.draft && (flags & fs.constants.O_RDWR)) writes++; return originalOpen(path, flags, ...rest); });
    expect(refused(args).message).toMatch(/inputs changed/); expect(writes).toBe(0);
    expect(fs.readFileSync(args.draft, 'utf8')).toBe(JSON.stringify(doc));
  });
  it('refuses a final-path swap during open and closes the old descriptor', () => {
    const args = fixture(), originalOpen = fs.openSync; let opened;
    vi.spyOn(fs, 'openSync').mockImplementation((path, flags, ...rest) => {
      const fd = originalOpen(path, flags, ...rest);
      if (path === args.draft && (flags & fs.constants.O_RDWR)) { opened = fd; fs.renameSync(args.draft, args.draft + '.original'); fs.writeFileSync(args.draft, JSON.stringify(doc)); }
      return fd;
    });
    expect(refused(args).message).toMatch(/inputs changed/);
    expect(() => fs.fstatSync(opened)).toThrow(); expect(fs.readFileSync(args.draft, 'utf8')).toBe(JSON.stringify(doc));
    expect(fs.readFileSync(args.draft + '.original', 'utf8')).toBe(JSON.stringify(doc));
  });
  it('refuses a write descriptor opened on a different regular file', () => {
    const args = fixture(), originalOpen = fs.openSync, other = join(args.request.projectDir, 'other.json');
    fs.writeFileSync(other, JSON.stringify(doc));
    vi.spyOn(fs, 'openSync').mockImplementation((path, flags, ...rest) => originalOpen(path === args.draft && (flags & fs.constants.O_RDWR) ? other : path, flags, ...rest));
    expect(refused(args).message).toMatch(/descriptor changed/); expect(fs.readFileSync(args.draft, 'utf8')).toBe(JSON.stringify(doc));
  });
  it('rechecks source and lock ownership on the returned descriptor before writing', () => {
    const args = fixture(), handle = acquire(args);
    fs.writeFileSync(args.source, 'export const changed = true;');
    expect(() => handle.assertCurrent()).toThrow(/inputs changed/);
    fs.writeFileSync(join(args.request.projectDir, '.testguard-annotations.lock'), 'foreign owner');
    expect(() => handle.assertCurrent()).toThrow(/lock/); expect(handle.release().released).toBe(false);
    expect(fs.readFileSync(args.draft, 'utf8')).toBe(JSON.stringify(doc));
  });
  it('cleans up its lock and retains recovery if destination open fails', () => {
    const args = fixture(), originalOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((path, flags, ...rest) => { if (path === args.draft && (flags & fs.constants.O_RDWR)) throw new Error('write-open denied'); return originalOpen(path, flags, ...rest); });
    const error = refused(args); expect(error.message).toBe('write-open denied'); expect(error.recoveryDir).toBeDefined(); expect(error.lockRelease).toEqual({ released: true });
    expect(fs.readFileSync(args.draft, 'utf8')).toBe(JSON.stringify(doc));
  });
  it('leaves repeated unchanged output without a write descriptor, lock or recovery', () => {
    const args = fixture(); fs.writeFileSync(args.draft, args.plan.output); args.plan = planDraftAppend(args.request);
    const handle = acquire(args); expect(handle.fd).toBeUndefined(); expect(handle.recoveryDir).toBeUndefined();
    expect(fs.existsSync(join(args.request.projectDir, '.testguard-annotations.lock'))).toBe(false);
    expect(fs.readFileSync(args.draft, 'utf8')).toBe(args.plan.output);
  });
  it('reports descriptor-close failure even when owned-lock release succeeds, including repeated release', () => {
    const args = fixture(), handle = acquire(args), originalClose = fs.closeSync;
    vi.spyOn(fs, 'closeSync').mockImplementation(fd => { originalClose(fd); if (fd === handle.fd) throw new Error('close uncertain'); });
    const result = handle.release();
    expect(result).toEqual({ released: false, reason: 'descriptor-close-failed', error: 'close uncertain', lockRelease: { released: true } });
    expect(handle.release()).toEqual(result); expect(() => handle.assertCurrent()).toThrow(/closed/);
    expect(fs.readFileSync(args.draft, 'utf8')).toBe(JSON.stringify(doc));
  });
});
