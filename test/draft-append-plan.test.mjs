import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planDraftAppend } from '../src/scaffold/plan-append.mjs';
import { validate } from '../spec/lib/validate.mjs';

const roots = [];
const claim = (id) => ({ id, statement: 'Absent input is rejected, regardless of storage backend.', severity: 'critical', source: { kind: 'incident', ref: 'opaque:independent-intent' }, producedBy: { producer: 'human' }, tags: ['intent'], defendedBy: ['test/guard.test.mjs'], faults: [{ id: 'S1', description: 'Lose the original guard.', file: 'src/original.mjs', find: 'if (!x)', replace: 'if (false)', faultClass: 'condition-forced', producedBy: { producer: 'human' } }] });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'testguard-draft-plan-')); roots.push(root);
  for (const dir of ['a', 'b']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'draft.json'), JSON.stringify({ schemaVersion: 1, claims: [claim('INTENT-001'), claim('OTHER-001')] }));
  writeFileSync(join(root, 'a/guard.mjs'), 'export function guard(x) {\n  if (!x) throw new Error("absent");\n}\n');
  writeFileSync(join(root, 'b/guard.py'), 'def guard(x):\n    if not x:\n        raise ValueError("absent")\n');
  return { projectDir: root, draftPath: 'draft.json', files: ['b/guard.py', 'a/guard.mjs'], claimId: 'INTENT-001' };
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function admittedPlan(args) { let plan; expect(() => { plan = planDraftAppend(args); }).not.toThrow(); return plan; }

describe('read-only multi-file append planning', () => {
  it('drives real JS/Python producers, preserving intent and sibling faults without publishing', () => {
    const args = fixture(); const before = readFileSync(join(args.projectDir, 'draft.json'));
    const plan = admittedPlan(args);
    expect(validate('claims', plan.doc).errors).toEqual([]);
    const original = JSON.parse(before);
    expect(plan.doc.claims[0]).toEqual({ ...original.claims[0], faults: plan.doc.claims[0].faults });
    expect(plan.doc.claims[0].faults[0]).toEqual(original.claims[0].faults[0]);
    expect(plan.doc.claims[1]).toEqual(original.claims[1]);
    expect(new Set(plan.doc.claims[0].faults.map((fault) => fault.file))).toEqual(new Set(['src/original.mjs', 'a/guard.mjs', 'b/guard.py']));
    expect(new Set(plan.doc.claims[0].faults.map((fault) => fault.id)).size).toBe(plan.doc.claims[0].faults.length);
    expect(plan.changed).toBe(true);
    expect(plan.stats.appended).toBe(plan.doc.claims[0].faults.length - 1);
    expect(plan.stats.generated).toBeGreaterThanOrEqual(plan.stats.appended);
    expect(JSON.parse(plan.output)).toEqual(plan.doc);
    expect(readFileSync(join(args.projectDir, 'draft.json'))).toEqual(before);
    expect(readdirSync(args.projectDir).sort()).toEqual(['a', 'b', 'draft.json']);
    expect(args.files).toEqual(['b/guard.py', 'a/guard.mjs']);
    plan.doc.claims[0].statement = 'changed';
    expect(plan.draft.doc).toEqual(original);
  });

  it('assigns the same IDs independent of argument order and makes repeat append unchanged', () => {
    const args = fixture(); const first = admittedPlan(args);
    expect(admittedPlan({ ...args, files: [...args.files].reverse() }).doc).toEqual(first.doc);
    writeFileSync(join(args.projectDir, 'draft.json'), first.output);
    const repeated = admittedPlan(args);
    expect(repeated.doc).toEqual(first.doc);
    expect(repeated.changed).toBe(false);
    expect(repeated.stats.appended).toBe(0);
    expect(repeated.stats.generated).toBe(first.stats.generated);
    expect(readFileSync(join(args.projectDir, 'draft.json'), 'utf8')).toBe(first.output);
  });

  it('charges generation across files, including proposals deduplicated against the draft', () => {
    const args = fixture(); const first = admittedPlan({ ...args, files: [args.files[1]] });
    expect(first.stats.generated).toBeGreaterThan(0);
    const before = readFileSync(join(args.projectDir, 'draft.json'));
    expect(() => planDraftAppend({ ...args, maxProposals: first.stats.generated })).toThrow(/proposal limit/);
    expect(readFileSync(join(args.projectDir, 'draft.json'))).toEqual(before);
    writeFileSync(join(args.projectDir, 'draft.json'), first.output);
    expect(() => planDraftAppend({ ...args, maxProposals: first.stats.generated })).toThrow(/proposal limit/);
  });

  it('refuses oversized serialized output without publishing a partial merge', () => {
    const args = fixture(); const before = readFileSync(join(args.projectDir, 'draft.json'));
    const initialBytes = Buffer.byteLength(JSON.stringify(JSON.parse(before), null, 2) + '\n');
    expect(() => planDraftAppend({ ...args, maxOutputBytes: initialBytes })).toThrow(/output byte limit/);
    expect(readFileSync(join(args.projectDir, 'draft.json'))).toEqual(before);
  });

  it.each([{ maxProposals: 4097 }, { maxOutputBytes: 2097153 }, { maxProposals: -1 }, { maxOutputBytes: Infinity }])('refuses limits which relax ceilings or cannot be measured: %j', (limits) => {
    expect(() => planDraftAppend({ ...fixture(), ...limits })).toThrow(/safe integer/);
  });
});
