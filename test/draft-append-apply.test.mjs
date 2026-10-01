import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planDraftAppend } from '../src/scaffold/plan-append.mjs';
import { applyDraftAppend } from '../src/scaffold/apply-append.mjs';
import { writeSpecDoc, readSpecDoc } from '../src/evidence/writer.mjs';

vi.mock('node:fs', async (original) => ({ ...await original() }));
const roots = [], recovery = [];
const doc = { schemaVersion: 1, claims: [{ id: 'INTENT-001', statement: 'Absent input is rejected.', severity: 'high', source: { kind: 'incident' }, producedBy: { producer: 'human' }, faults: [{ id: 'F1', description: 'Drop guard.', file: 'old.mjs', find: 'if (!x)', replace: 'if (false)', faultClass: 'condition-forced', producedBy: { producer: 'agent' } }] }] };
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'testguard-append-apply-'))); roots.push(root);
  const draft = join(root, 'draft.json'), source = join(root, 'guard.mjs');
  fs.writeFileSync(draft, JSON.stringify(doc)); fs.writeFileSync(source, 'export function guard(x) {\n  if (!x) throw new Error("absent");\n}\n');
  const request = { projectDir: root, draftPath: 'draft.json', files: ['guard.mjs'], claimId: 'INTENT-001' };
  return { request, plan: planDraftAppend(request), draft, source };
}
function apply(args) {
  let result; expect(() => { result = applyDraftAppend(args); }).not.toThrow();
  if (result.recoveryDir) recovery.push(result.recoveryDir); return result;
}
function unchanged(args, result) {
  expect(result.ok).toBe(false); expect(result.state).toBe('refused'); expect(result.writeAttempted).toBe(false);
  expect(fs.readFileSync(args.draft, 'utf8')).toBe(JSON.stringify(doc));
}
afterEach(() => { vi.restoreAllMocks(); recovery.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });

describe('recoverable validated draft append', () => {
  it('writes exactly the validated merged output and keeps durable original/started/result journals', () => {
    const args = fixture(), result = apply(args);
    expect(result.ok).toBe(true); expect(result.state).toBe('updated'); expect(result.bytesWritten).toBe(Buffer.byteLength(args.plan.output));
    expect(fs.readFileSync(args.draft, 'utf8')).toBe(args.plan.output); expect(readSpecDoc('claims', args.draft)).toEqual(args.plan.doc);
    expect(fs.readFileSync(join(result.recoveryDir, 'draft.original'), 'utf8')).toBe(JSON.stringify(doc));
    expect(JSON.parse(fs.readFileSync(join(result.recoveryDir, 'started.json'))).state).toBe('started');
    expect(JSON.parse(fs.readFileSync(join(result.recoveryDir, 'result.json'))).ok).toBe(true);
    expect(fs.existsSync(join(args.request.projectDir, '.testguard-annotations.lock'))).toBe(false);
    expect(readSpecDoc('claims', args.draft).claims[0].statement).toBe(doc.claims[0].statement);
  });
  it('handles short writes with explicit offsets until complete', () => {
    const args = fixture(), originalWrite = fs.writeSync;
    vi.spyOn(fs, 'writeSync').mockImplementation((fd, bytes, offset, length, position) => originalWrite(fd, bytes, offset, Math.min(length, 7), position));
    const result = apply(args); expect(result.ok).toBe(true); expect(fs.readFileSync(args.draft, 'utf8')).toBe(args.plan.output);
  });
  it('truncates trailing original bytes only after the complete replacement is written', () => {
    const args = fixture(); fs.appendFileSync(args.draft, ' '.repeat(4000)); args.plan = planDraftAppend(args.request);
    expect(Buffer.byteLength(args.plan.output)).toBeLessThan(fs.statSync(args.draft).size);
    const result = apply(args); expect(result.ok).toBe(true); expect(fs.readFileSync(args.draft, 'utf8')).toBe(args.plan.output);
  });
  it('does not rewrite bytes or timestamps for an unchanged repeated append', () => {
    const args = fixture(); fs.writeFileSync(args.draft, args.plan.output); args.plan = planDraftAppend(args.request);
    const before = fs.statSync(args.draft), result = apply(args);
    expect(result.ok).toBe(true); expect(result.state).toBe('unchanged'); expect(result.recoveryDir).toBeUndefined(); expect(result.writeAttempted).toBe(false);
    expect(fs.statSync(args.draft).mtimeMs).toBe(before.mtimeMs); expect(fs.readFileSync(args.draft, 'utf8')).toBe(args.plan.output);
  });
  it('refuses started-journal failure before writing', () => {
    const args = fixture(), originalWrite = fs.writeFileSync, originalOpen = fs.openSync; let startedFd;
    vi.spyOn(fs, 'openSync').mockImplementation((path, ...rest) => { const fd = originalOpen(path, ...rest); if (String(path).endsWith('/started.json')) startedFd = fd; return fd; });
    vi.spyOn(fs, 'writeFileSync').mockImplementation((path, ...rest) => { if (path === startedFd) throw new Error('started persistence failed'); return originalWrite(path, ...rest); });
    unchanged(args, apply(args));
  });
  it('refuses source changes during started-journal persistence before any draft write', () => {
    const args = fixture(), originalSync = fs.fsyncSync; let count = 0;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { originalSync(fd); if (++count === 3) fs.writeFileSync(args.source, 'export const changed = true;'); });
    unchanged(args, apply(args));
  });
  it('refuses an ancestor symlink swap after the started marker and never writes the redirected draft', () => {
    const args = fixture(), foreign = fixture(), originalSync = fs.fsyncSync; let count = 0;
    const nested = join(args.request.projectDir, 'sub'); fs.mkdirSync(nested); fs.renameSync(args.draft, join(nested, 'draft.json'));
    args.draft = join(nested, 'draft.json'); args.request.draftPath = 'sub/draft.json'; args.plan = planDraftAppend(args.request);
    const foreignDoc = structuredClone(doc); foreignDoc.claims[0].statement = 'Foreign draft must remain untouched.';
    fs.writeFileSync(foreign.draft, JSON.stringify(foreignDoc));
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { originalSync(fd); if (++count === 3) { fs.renameSync(nested, nested + '.original'); fs.symlinkSync(foreign.request.projectDir, nested, 'dir'); } });
    const result = apply(args); expect(result.ok).toBe(false); expect(result.state).toBe('refused'); expect(result.writeAttempted).toBe(false);
    expect(result.failed[0].reason).toMatch(/symlink/); expect(fs.readFileSync(foreign.draft, 'utf8')).toBe(JSON.stringify(foreignDoc));
    expect(fs.readFileSync(join(nested + '.original', 'draft.json'), 'utf8')).toBe(JSON.stringify(doc));
  });
  it('reports zero-progress and partial writes without claiming success or rolling back', () => {
    const args = fixture(), originalWrite = fs.writeSync, originalBytes = fs.readFileSync(args.draft); let count = 0;
    vi.spyOn(fs, 'writeSync').mockImplementation((fd, bytes, offset, length, position) => ++count === 1 ? originalWrite(fd, bytes, offset, 5, position) : 0);
    const result = apply(args); expect(result.ok).toBe(false); expect(result.state).toBe('write-unconfirmed'); expect(result.bytesWritten).toBe(5);
    expect(fs.readFileSync(args.draft).subarray(0, 5)).toEqual(Buffer.from(args.plan.output).subarray(0, 5));
    expect(fs.readFileSync(args.draft).subarray(5)).toEqual(originalBytes.subarray(5));
    expect(fs.readFileSync(join(result.recoveryDir, 'draft.original'), 'utf8')).toBe(JSON.stringify(doc));
    expect(result.failed[0].stage).toBe('draft-write');
  });
  it.each(['truncate', 'draft-fsync'])('does not report updated after %s failure', stage => {
    const args = fixture();
    if (stage === 'truncate') vi.spyOn(fs, 'ftruncateSync').mockImplementation(() => { throw new Error('truncate failed'); });
    else { const originalSync = fs.fsyncSync; let count = 0; vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { if (++count === 4) throw new Error('draft fsync failed'); originalSync(fd); }); }
    const result = apply(args); expect(result.ok).toBe(false); expect(result.state).toBe('write-unconfirmed'); expect(result.failed[0].stage).toBe(stage);
  });
  it('refuses changed output bytes even when the JSON remains conforming', () => {
    const args = fixture(), originalSync = fs.fsyncSync; let count = 0;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { originalSync(fd); if (++count === 4) { const changed = structuredClone(args.plan.doc); changed.claims[0].statement = 'Absent input is accepted.'; const output = JSON.stringify(changed, null, 2) + '\n'; expect(Buffer.byteLength(output)).toBe(Buffer.byteLength(args.plan.output)); fs.writeFileSync(args.draft, output); } });
    const result = apply(args); expect(result.ok).toBe(false); expect(result.state).toBe('write-unconfirmed'); expect(result.failed[0].stage).toBe('verification');
    expect(readSpecDoc('claims', args.draft).claims[0].statement).toBe('Absent input is accepted.');
  });
  it('refuses post-write path replacement and preserves the foreign draft', () => {
    const args = fixture(), originalSync = fs.fsyncSync; let count = 0;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { originalSync(fd); if (++count === 4) { fs.renameSync(args.draft, args.draft + '.ours'); fs.writeFileSync(args.draft, JSON.stringify(doc)); } });
    const result = apply(args); expect(result.ok).toBe(false); expect(result.state).toBe('write-unconfirmed');
    expect(fs.readFileSync(args.draft, 'utf8')).toBe(JSON.stringify(doc)); expect(fs.readFileSync(args.draft + '.ours', 'utf8')).toBe(args.plan.output);
  });
  it('refuses source drift after the draft write and retains recovery without rollback', () => {
    const args = fixture(), originalSync = fs.fsyncSync; let count = 0;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { originalSync(fd); if (++count === 4) fs.writeFileSync(args.source, 'export const changed = true;'); });
    const result = apply(args); expect(result.ok).toBe(false); expect(result.state).toBe('write-unconfirmed'); expect(fs.readFileSync(args.draft, 'utf8')).toBe(args.plan.output);
  });
  it('preserves a foreign lock and refuses updated on release failure', () => {
    const args = fixture(), originalClose = fs.closeSync; let draftFd;
    const originalOpen = fs.openSync; vi.spyOn(fs, 'openSync').mockImplementation((path, flags, ...rest) => { const fd = originalOpen(path, flags, ...rest); if (path === args.draft && flags & fs.constants.O_RDWR) draftFd = fd; return fd; });
    vi.spyOn(fs, 'closeSync').mockImplementation(fd => { if (fd === draftFd) fs.writeFileSync(join(args.request.projectDir, '.testguard-annotations.lock'), 'foreign owner'); originalClose(fd); });
    const result = apply(args); expect(result.ok).toBe(false); expect(result.state).toBe('write-unconfirmed'); expect(result.failed[0].stage).toBe('release');
    expect(fs.readFileSync(join(args.request.projectDir, '.testguard-annotations.lock'), 'utf8')).toBe('foreign owner');
  });
  it('requires the result journal to persist before reporting success', () => {
    const args = fixture(), originalSync = fs.fsyncSync; let count = 0;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { if (++count === 5) throw new Error('result journal failed'); originalSync(fd); });
    const result = apply(args); expect(result.ok).toBe(false); expect(result.state).toBe('write-unconfirmed'); expect(result.failed[0].stage).toBe('result-journal');
  });
  it('reports lock-descriptor close errors rather than escaping or returning updated', () => {
    const args = fixture(), originalOpen = fs.openSync, originalClose = fs.closeSync; let lockFd;
    vi.spyOn(fs, 'openSync').mockImplementation((path, ...rest) => { const fd = originalOpen(path, ...rest); if (String(path).endsWith('.testguard-annotations.lock')) lockFd = fd; return fd; });
    vi.spyOn(fs, 'closeSync').mockImplementation(fd => { originalClose(fd); if (fd === lockFd) throw new Error('lock close uncertain'); });
    const result = apply(args); expect(result.ok).toBe(false); expect(result.state).toBe('write-unconfirmed'); expect(result.failed[0].stage).toBe('release');
    expect(fs.readFileSync(args.draft, 'utf8')).toBe(args.plan.output);
  });
  it('retains recovery and the original refusal when preparation cleanup also fails', () => {
    const args = fixture(), originalOpen = fs.openSync, originalClose = fs.closeSync, originalSync = fs.fsyncSync; let lockFd, count = 0;
    vi.spyOn(fs, 'openSync').mockImplementation((path, ...rest) => { const fd = originalOpen(path, ...rest); if (String(path).endsWith('.testguard-annotations.lock')) lockFd = fd; return fd; });
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { originalSync(fd); if (++count === 2) fs.writeFileSync(join(args.request.projectDir, '.testguard-annotations.lock'), 'foreign owner'); });
    vi.spyOn(fs, 'closeSync').mockImplementation(fd => { originalClose(fd); if (fd === lockFd) throw new Error('lock close uncertain'); });
    const result = apply(args); unchanged(args, result); expect(result.recoveryDir).toBeDefined(); expect(result.release.released).toBe(false);
    expect(result.failed[0].reason).toMatch(/lock changed/);
    expect(fs.readFileSync(join(result.recoveryDir, 'draft.original'), 'utf8')).toBe(JSON.stringify(doc));
  });
  it('validates before invoking a custom publisher and never writes its pathname', () => {
    const args = fixture(), publish = vi.fn();
    expect(() => writeSpecDoc('claims', args.draft, { schemaVersion: 1, claims: [{ id: 'bad' }] }, { publish })).toThrow(/refusing to write/);
    expect(publish).not.toHaveBeenCalled(); expect(fs.readFileSync(args.draft, 'utf8')).toBe(JSON.stringify(doc));
    writeSpecDoc('claims', args.draft, doc, { publish }); expect(publish).toHaveBeenCalledWith(JSON.stringify(doc, null, 2) + '\n');
    expect(() => writeSpecDoc('claims', args.draft, doc, { publish: true })).toThrow(TypeError);
    expect(fs.readFileSync(args.draft, 'utf8')).toBe(JSON.stringify(doc));
  });
});
