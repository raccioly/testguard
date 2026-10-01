import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { planDraftAppend } from '../src/scaffold/plan-append.mjs';
import { prepareDraftAppend } from '../src/scaffold/prepare-append.mjs';

vi.mock('node:fs', async (original) => ({ ...await original() }));
const roots = [], recovery = [], handles = [];
const doc = { schemaVersion: 1, claims: [{ id: 'INTENT-001', statement: 'Absent input is rejected.', severity: 'high', source: { kind: 'incident' }, producedBy: { producer: 'human' }, faults: [{ id: 'F1', description: 'Drop guard.', file: 'old.mjs', find: 'if (!x)', replace: 'if (false)', faultClass: 'condition-forced', producedBy: { producer: 'agent' } }] }] };
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'testguard-append-preparation-')); roots.push(root);
  fs.writeFileSync(join(root, 'draft.json'), JSON.stringify(doc));
  fs.writeFileSync(join(root, 'guard.mjs'), 'export function guard(x) {\n  if (!x) throw new Error("absent");\n}\n');
  const request = { projectDir: root, draftPath: 'draft.json', files: ['guard.mjs'], claimId: 'INTENT-001' };
  return { request, plan: planDraftAppend(request) };
}
function prepare(args) {
  let result;
  expect(() => { result = prepareDraftAppend(args); }).not.toThrow();
  handles.push(result); if (result.recoveryDir) recovery.push(result.recoveryDir);
  return result;
}
function refusal(args) {
  let error;
  try {
    const result = prepareDraftAppend(args);
    if (result) { handles.push(result); if (result.recoveryDir) recovery.push(result.recoveryDir); }
  } catch (caught) { error = caught; if (caught.recoveryDir) recovery.push(caught.recoveryDir); }
  expect(error).toBeDefined(); return error;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); handles.splice(0).forEach((handle) => handle.release()); recovery.splice(0).forEach((path) => fs.rmSync(path, { recursive: true, force: true })); roots.splice(0).forEach((path) => fs.rmSync(path, { recursive: true, force: true })); });

describe('recoverable append preparation never writes the draft', () => {
  it('replays current inputs, holds the shared owned lock and fsyncs recoverable originals', () => {
    const args = fixture(); const original = fs.readFileSync(join(args.request.projectDir, 'draft.json'));
    const syncs = vi.spyOn(fs, 'fsyncSync'); const handle = prepare(args);
    expect(handle.ready).toBe(true); expect(handle.plan).toEqual(args.plan);
    expect(relative(args.request.projectDir, handle.recoveryDir).startsWith('..')).toBe(true);
    expect(fs.statSync(handle.recoveryDir).mode & 0o777).toBe(0o700);
    let saved, manifest;
    expect(() => { saved = fs.readFileSync(join(handle.recoveryDir, 'draft.original')); }).not.toThrow();
    expect(saved).toEqual(original);
    expect(() => { manifest = JSON.parse(fs.readFileSync(join(handle.recoveryDir, 'manifest.json'))); }).not.toThrow();
    expect(manifest.state).toBe('prepared'); expect(manifest.sourceHash).toBe(args.plan.draft.hash);
    expect(manifest.sources).toHaveLength(1);
    expect(syncs).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(join(args.request.projectDir, 'draft.json'))).toEqual(original);
    expect(fs.existsSync(join(args.request.projectDir, '.testguard-annotations.lock'))).toBe(true);
    expect(() => handle.assertOwned()).not.toThrow();
    expect(handle.release()).toEqual({ released: true });
  });

  it('refuses stale draft/source inputs and caller-altered proposals before creating a lock', () => {
    const args = fixture(); args.plan.doc.claims[0].statement = 'forged';
    expect(refusal(args).message).toMatch(/plan changed/);
    expect(fs.readdirSync(args.request.projectDir).sort()).toEqual(['draft.json', 'guard.mjs']);
    args.plan = planDraftAppend(args.request);
    fs.writeFileSync(join(args.request.projectDir, 'guard.mjs'), 'export const changed = true;');
    expect(refusal(args).message).toMatch(/plan changed/);
    expect(fs.readFileSync(join(args.request.projectDir, 'draft.json'), 'utf8')).toBe(JSON.stringify(doc));
  });

  it('replays again under the lock and preserves a concurrent draft edit', () => {
    const args = fixture(); const originalOpen = fs.openSync;
    const edited = structuredClone(doc); edited.claims[0].statement = 'Concurrent independent intent';
    vi.spyOn(fs, 'openSync').mockImplementation((path, ...rest) => {
      const fd = originalOpen(path, ...rest);
      if (String(path).endsWith('.testguard-annotations.lock')) fs.writeFileSync(join(args.request.projectDir, 'draft.json'), JSON.stringify(edited));
      return fd;
    });
    const error = refusal(args);
    expect(error.message).toMatch(/plan changed/); expect(error.lockRelease).toEqual({ released: true });
    expect(fs.readFileSync(join(args.request.projectDir, 'draft.json'), 'utf8')).toBe(JSON.stringify(edited));
    expect(fs.existsSync(join(args.request.projectDir, '.testguard-annotations.lock'))).toBe(false);
  });

  it('never reclaims an existing authoring lock', () => {
    const args = fixture(); const lock = join(args.request.projectDir, '.testguard-annotations.lock');
    fs.writeFileSync(lock, 'foreign owner');
    expect(refusal(args).message).toMatch(/already exists/);
    expect(fs.readFileSync(lock, 'utf8')).toBe('foreign owner');
    expect(fs.readFileSync(join(args.request.projectDir, 'draft.json'), 'utf8')).toBe(JSON.stringify(doc));
  });

  it('returns deeply frozen owned data without freezing the caller plan', () => {
    const args = fixture(); const handle = prepare(args);
    expect(() => { handle.plan.doc.claims[0].statement = 'forged'; }).toThrow(TypeError);
    expect(() => { handle.plan.sources[0].source = 'forged'; }).toThrow(TypeError);
    args.plan.doc.claims[0].statement = 'caller edit';
    expect(handle.plan.doc.claims[0].statement).toBe(doc.claims[0].statement);
  });

  it('reports partial recovery and releases its lock if persistence fails', () => {
    const args = fixture(); vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('injected fsync failure'); });
    const error = refusal(args);
    expect(error.message).toMatch(/injected fsync/); expect(error.recoveryDir).toBeDefined();
    expect(error.lockRelease).toEqual({ released: true });
    expect(fs.readFileSync(join(args.request.projectDir, 'draft.json'), 'utf8')).toBe(JSON.stringify(doc));
  });

  it('refuses recovery inside the checkout before persisting originals', () => {
    const args = fixture();
    for (const name of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(name, args.request.projectDir);
    const error = refusal(args);
    expect(error.message).toMatch(/outside the project/); expect(error.recoveryDir).toBeUndefined();
    expect(error.lockRelease).toEqual({ released: true });
    expect(fs.readdirSync(args.request.projectDir).sort()).toEqual(['draft.json', 'guard.mjs']);
  });

  it('does not return ready or unlink a foreign lock changed during recovery persistence', () => {
    const args = fixture(); const lock = join(args.request.projectDir, '.testguard-annotations.lock');
    const originalSync = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce((fd) => { fs.writeFileSync(lock, 'foreign owner'); return originalSync(fd); });
    const error = refusal(args);
    expect(error.message).toMatch(/lock changed/);
    expect(error.lockRelease).toEqual({ released: false, reason: 'lock-changed' });
    expect(fs.readFileSync(lock, 'utf8')).toBe('foreign owner');
    expect(fs.readFileSync(join(args.request.projectDir, 'draft.json'), 'utf8')).toBe(JSON.stringify(doc));
  });

  it('prepares an unchanged append without lock or recovery writes', () => {
    const args = fixture(); fs.writeFileSync(join(args.request.projectDir, 'draft.json'), args.plan.output);
    args.plan = planDraftAppend(args.request); expect(args.plan.changed).toBe(false);
    const writes = vi.spyOn(fs, 'writeFileSync'); const handle = prepare(args);
    expect(handle.recoveryDir).toBeUndefined(); expect(writes).not.toHaveBeenCalled();
    expect(handle.release()).toEqual({ released: true });
    expect(fs.readdirSync(args.request.projectDir).sort()).toEqual(['draft.json', 'guard.mjs']);
  });
});
