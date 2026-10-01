import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { scaffoldCommand } from '../src/commands/scaffold.mjs';
import { validate } from '../spec/lib/validate.mjs';
import * as fs from 'node:fs';

vi.mock('node:fs', async (original) => ({ ...await original() }));

const roots = [], recovery = [];
const doc = { schemaVersion: 1, claims: [{ id: 'INTENT-001', statement: 'Absent input is rejected.', severity: 'high', source: { kind: 'incident' }, producedBy: { producer: 'human' }, faults: [{ id: 'F1', description: 'Drop guard.', file: 'old.mjs', find: 'if (!x)', replace: 'if (false)', faultClass: 'condition-forced', producedBy: { producer: 'agent' } }] }] };
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'testguard-append-cli-'))); roots.push(root);
  writeFileSync(join(root, 'draft.json'), JSON.stringify(doc));
  writeFileSync(join(root, 'guard.mjs'), 'export function guard(x) {\n if (!x) throw new Error("absent");\n}\n');
  writeFileSync(join(root, 'guard.py'), 'def guard(x):\n    if not x: raise ValueError("absent")\n');
  vi.spyOn(process, 'cwd').mockReturnValue(root); return root;
}
async function run(args) {
  const out = [], err = [], code = await main(args, { out: s => out.push(s), err: s => err.push(s) });
  for (const line of [...out, ...err]) if (line.startsWith('private recovery: ')) recovery.push(line.slice('private recovery: '.length));
  return { code, out, err };
}
afterEach(() => { vi.restoreAllMocks(); recovery.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
describe('explicit existing-intent draft append CLI', () => {
  it('previews a conforming multi-file draft without side effects', async () => {
    const root = fixture(), before = readdirSync(root).sort();
    const result = await run(['scaffold', 'guard.py', 'guard.mjs', '--into', 'draft.json', '--claim', 'INTENT-001', '--json']);
    expect(result.code).toBe(0); expect(result.err).toEqual([]); const output = JSON.parse(result.out.join('\n'));
    expect(validate('claims', output).ok).toBe(true); expect(output.claims[0].statement).toBe(doc.claims[0].statement);
    expect(output.claims[0].faults.some(f => f.file === 'guard.py')).toBe(true); expect(output.claims[0].faults.some(f => f.file === 'guard.mjs')).toBe(true);
    expect(readFileSync(join(root, 'draft.json'), 'utf8')).toBe(JSON.stringify(doc)); expect(readdirSync(root).sort()).toEqual(before);
  });
  it('updates only the disposable draft and repeats unchanged, never claims verified coverage', async () => {
    const root = fixture(), args = ['scaffold', 'guard.mjs', 'guard.py', '--into', 'draft.json', '--claim', 'INTENT-001'];
    const first = await run(args); expect(first.code).toBe(0); expect(first.out[0]).toMatch(/unproven draft updated/);
    const bytes = readFileSync(join(root, 'draft.json'), 'utf8'); expect(validate('claims', JSON.parse(bytes)).ok).toBe(true);
    const second = await run(args); expect(second.code).toBe(0); expect(second.out[0]).toMatch(/unproven draft unchanged/);
    expect(readFileSync(join(root, 'draft.json'), 'utf8')).toBe(bytes); expect(second.out.some(s => s.startsWith('private recovery:'))).toBe(false);
  });
  it('keeps equal-basename targets distinct through actual publication while preserving sibling intent', async () => {
    const root = fixture();
    for (const dir of ['left', 'right']) { fs.mkdirSync(join(root, dir)); writeFileSync(join(root, dir, 'guard.mjs'), readFileSync(join(root, 'guard.mjs'))); }
    const supplied = structuredClone(doc); supplied.claims.push({ ...structuredClone(doc.claims[0]), id: 'SIBLING-001', statement: 'Independent sibling intent.' });
    writeFileSync(join(root, 'draft.json'), JSON.stringify(supplied));
    const args = ['scaffold', 'right/guard.mjs', 'left/guard.mjs', '--into', 'draft.json', '--claim', 'INTENT-001'];
    const result = await run(args); expect(result.code).toBe(0);
    const output = JSON.parse(readFileSync(join(root, 'draft.json'), 'utf8'));
    expect(output.claims[1]).toEqual(supplied.claims[1]); expect(output.claims[0].source).toEqual(supplied.claims[0].source);
    expect(output.claims[0].faults[0]).toEqual(supplied.claims[0].faults[0]);
    expect(new Set(output.claims[0].faults.map(f => f.file))).toEqual(new Set(['old.mjs', 'left/guard.mjs', 'right/guard.mjs']));
    expect(new Set(output.claims[0].faults.map(f => f.id)).size).toBe(output.claims[0].faults.length);
    const repeated = await run(['scaffold', 'left/guard.mjs', 'right/guard.mjs', '--into', 'draft.json', '--claim', 'INTENT-001']);
    expect(repeated.code).toBe(0); expect(repeated.out[0]).toMatch(/unchanged/);
    expect(JSON.parse(readFileSync(join(root, 'draft.json'), 'utf8'))).toEqual(output);
  });
  it.each([
    { args: ['status', '--into', 'draft.json'] },
    { args: ['status', '.', '--into', 'draft.json', '--claim', 'INTENT-001'] },
    { args: ['scaffold', 'guard.mjs', '--into', 'draft.json'] },
    { args: ['scaffold', '--into', 'draft.json', '--claim', 'INTENT-001'] },
    { args: ['scaffold', 'guard.mjs', '--into', 'draft.json', '--into', 'other.json', '--claim', 'INTENT-001'] },
    { args: ['scaffold', 'guard.mjs', '--into', 'draft.json', '--claim', 'INTENT-001,OTHER'] },
    { args: ['scaffold', 'guard.mjs', '--into', 'draft.json', '--claim', 'INTENT-001', '--claim', 'OTHER'] },
    ...['out', 'claims', 'baseline', 'confirm', 'budget', 'runner', 'severity'].map(flag => ({ args: ['scaffold', 'guard.mjs', '--into', 'draft.json', '--claim', 'INTENT-001', '--' + flag, flag === 'confirm' ? '3' : 'x'] })),
    { args: ['scaffold', 'guard.mjs', '--into', 'draft.json', '--claim', 'INTENT-001', '--serial'] },
  ])('rejects explicit incompatible invocation before touching files: $args', async ({ args }) => {
    const root = fixture(), before = readdirSync(root).sort(); const result = await run(args);
    expect(result.code).toBe(3); expect(result.out).toEqual([]); expect(result.err.join('\n')).toMatch(/--into/);
    expect(readFileSync(join(root, 'draft.json'), 'utf8')).toBe(JSON.stringify(doc)); expect(readdirSync(root).sort()).toEqual(before);
  });
  it('refuses canonical destination even when it contains a valid draft', async () => {
    const root = fixture(); writeFileSync(join(root, 'testguard.claims.json'), JSON.stringify(doc));
    const result = await run(['scaffold', 'guard.mjs', '--into', 'testguard.claims.json', '--claim', 'INTENT-001']);
    expect(result.code).toBe(2); expect(result.out).toEqual([]); expect(result.err.join('\n')).toMatch(/protected-destination/);
    expect(readFileSync(join(root, 'testguard.claims.json'), 'utf8')).toBe(JSON.stringify(doc));
  });
  it('keeps ordinary one-file JSON scaffold and command-specific help compatible', async () => {
    fixture(); const result = await run(['scaffold', 'guard.mjs', '--claim', 'NEW', '--json']);
    expect(result.code).toBe(0); expect(validate('claims', JSON.parse(result.out.join('\n'))).ok).toBe(true);
    const help = await run(['scaffold', '--help']); expect(help.code).toBe(0); expect(help.out.join('\n')).toMatch(/--into/);
  });
  it('returns precondition failure and recovery, not successful output, after a draft fsync error', async () => {
    fixture(); const originalSync = fs.fsyncSync; let count = 0;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { if (++count === 4) throw new Error('draft fsync failed'); originalSync(fd); });
    const result = await run(['scaffold', 'guard.mjs', '--into', 'draft.json', '--claim', 'INTENT-001']);
    expect(result.code).toBe(2); expect(result.out).toEqual([]);
    expect(result.err.join('\n')).toMatch(/write-unconfirmed/); expect(result.err.join('\n')).toMatch(/private recovery:/);
  });
  it('also checks incompatible options at direct handler entry', async () => {
    const root = fixture(), err = [], code = await scaffoldCommand({ projectDir: root, file: 'guard.mjs', values: { into: ['draft.json'], claim: ['INTENT-001'], out: 'other.json' } }, { out: () => { throw new Error('unexpected output'); }, err: s => err.push(s) });
    expect(code).toBe(3); expect(err.join('\n')).toMatch(/--out/);
  });
});
