import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { claimsCommand } from '../src/commands/claims.mjs';
import { computeStatus, renderStatus } from '../src/status/status.mjs';
import { validate } from '../spec/lib/validate.mjs';

const roots = [];
const failures = vi.hoisted(() => ({ open: false }));
vi.mock('node:fs', async (original) => {
  const actual = await original();
  return { ...actual, openSync: (...args) => {
    if (failures.open && String(args[0]).replaceAll('\\', '/').endsWith('/unreadable.md')) throw new Error('EACCES: private source path');
    return actual.openSync(...args);
  } };
});
afterEach(() => { failures.open = false; roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
function project(kind = 'manual') {
  const dir = mkdtempSync(join(tmpdir(), 'tg-annotation-advice-')); roots.push(dir);
  writeFileSync(join(dir, 'a.mjs'), 'export const allowed = true;\n');
  const fault = { id: 'F1', description: 'Break condition.', faultClass: 'other', file: 'a.mjs', find: 'true', replace: 'false', producedBy: { producer: 'human' } };
  const claim = { id: 'A-1', statement: 'The intended condition holds.', severity: 'high', source: { kind }, producedBy: { producer: 'human' }, faults: [fault, { ...fault, id: 'F2' }] };
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify({ schemaVersion: 1, claims: [claim] }));
  return dir;
}
async function inspect(dir, json = true) {
  const lines = [];
  const code = await claimsCommand({ projectDir: dir, values: { json }, version: 'test' }, { out: (s) => lines.push(s), err: (s) => { throw new Error(s); } });
  return { code, text: lines.join('\n'), doc: json ? JSON.parse(lines.join('\n')) : undefined };
}
describe('annotation guidance is not verification', () => {
  it('reports one advisory per missing ID, not per fault, without turning manual claims into drift', async () => {
    const dir = project(); const { code, doc } = await inspect(dir);
    expect(code).toBe(0);
    expect(doc.annotationAdvisory.missingIds).toEqual(['A-1']);
    expect(doc.drift.stale).toEqual([]);
    expect(doc.annotationAdvisory.notes.join('\n')).toContain('exact fault anchors remain checked');
    expect(doc.annotationAdvisory.notes.join('\n')).toContain('testguard claims --annotate');
    expect((await inspect(dir, false)).text).toContain('ANNOTATION ADVISORY');
  });
  it('clears advisory for scanned links without promoting claim origin or stale verification', async () => {
    const dir = project();
    writeFileSync(join(dir, 'a.mjs'), '// @claim A-1\nexport const allowed = true;\n');
    const { doc } = await inspect(dir);
    expect(doc.annotationAdvisory).toEqual({ missingIds: [], notes: [] });
    expect(doc.claims.claims[0].source.kind).toBe('manual');
    const status = computeStatus({ projectDir: dir });
    expect(status.state).toBe('unprobed');
    expect(status.next.action).toBe('probe');
    expect(status.notes.some((n) => n.includes('ANNOTATION ADVISORY'))).toBe(false);
  });
  it('preserves annotation-sourced missing-link claims drift', async () => {
    const dir = project('annotation'); const { code, doc } = await inspect(dir);
    expect(code).toBe(1);
    expect(doc.drift.stale.map((c) => c.id)).toEqual(['A-1']);
    expect(doc.annotationAdvisory.missingIds).toEqual(['A-1']);
  });
  it('keeps status notes conforming, actionable and subordinate to invalid anchors', () => {
    const dir = project();
    const before = computeStatus({ projectDir: dir });
    expect(before.state).toBe('unprobed'); expect(before.next.action).toBe('probe');
    expect(before.notes.join('\n')).toContain('ANNOTATION ADVISORY');
    expect(renderStatus(before)).toContain('testguard claims --annotate');
    expect(validate('status', before).ok).toBe(true);
    writeFileSync(join(dir, 'a.mjs'), 'export const allowed = false;\n');
    const after = computeStatus({ projectDir: dir });
    expect(after.state).toBe('invalid-anchors'); expect(after.next.action).toBe('repair-fault');
    expect(after.notes.join('\n')).toContain('ANNOTATION ADVISORY');
    expect(validate('status', after).ok).toBe(true);
  });
  it('reports unavailable advice rather than missing IDs for oversized unrelated source', () => {
    const dir = project();
    writeFileSync(join(dir, 'huge.md'), 'x'.repeat(256 * 1024 + 1));
    const status = computeStatus({ projectDir: dir });
    expect(status.state).toBe('unprobed'); expect(status.next.action).toBe('probe');
    expect(status.notes.join('\n')).toContain('ANNOTATION ADVISORY unavailable');
    expect(status.notes.join('\n')).not.toContain('Missing source annotation:');
    expect(validate('status', status).ok).toBe(true);
  });
  it('keeps status available when an unrelated source cannot be read', () => {
    const dir = project(); writeFileSync(join(dir, 'unreadable.md'), '@claim A-1'); failures.open = true;
    const status = computeStatus({ projectDir: dir });
    expect(status.state).toBe('unprobed'); expect(status.next.action).toBe('probe');
    expect(status.notes.join('\n')).toContain('ANNOTATION ADVISORY unavailable');
    expect(status.notes.join('\n')).not.toContain('EACCES');
    expect(status.notes.join('\n')).not.toContain('Missing source annotation:');
  });
  it('finishes lexical scanning for long prose tokens without a hyphen', () => {
    const dir = project(); writeFileSync(join(dir, 'prose.md'), `@claim ${'a'.repeat(256)}\n`);
    const run = spawnSync(process.execPath, ['--input-type=module', '-e',
      'const { projectAnnotationAdvisory, scanAnnotations } = await import(process.argv[1]); const advice = projectAnnotationAdvisory(process.argv[2], { claims: [{ id: "A-1" }] }); if (advice.missingIds.join() !== "A-1" || scanAnnotations(process.argv[2]).length) process.exit(1);',
      new URL('../src/claims/annotations.mjs', import.meta.url).href, dir], { encoding: 'utf8', timeout: 2000 });
    expect(run.error).toBeUndefined(); expect(run.status).toBe(0);
  });
  it('promptly refuses valid shared-format IDs outside placement vocabulary', () => {
    const dir = project(); const path = join(dir, 'testguard.claims.json');
    const claims = { schemaVersion: 1, claims: [{ id: 'a'.repeat(128), statement: 'Intended behavior.', severity: 'high', source: { kind: 'manual' }, producedBy: { producer: 'human' }, faults: [{ id: 'F1', file: 'a.mjs', find: 'true', replace: 'false', description: 'Break behavior.', faultClass: 'other', producedBy: { producer: 'human' } }] }] };
    expect(validate('claims', claims).ok).toBe(true); writeFileSync(path, JSON.stringify(claims));
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../cli/testguard.mjs', import.meta.url)), 'claims', dir, '--annotate', '--json'], { encoding: 'utf8', timeout: 2000 });
    expect(run.error).toBeUndefined(); expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout).refused[0].reason).toBe('unsupported-claim-id');
  });
  it('explicitly preserves custom claims selection in preview advice', async () => {
    const dir = project(); const custom = join(dir, 'custom.json');
    writeFileSync(custom, JSON.stringify({ schemaVersion: 1, claims: [{ id: 'B-1', statement: 'Custom intent.', severity: 'high', source: { kind: 'manual' }, producedBy: { producer: 'human' }, faults: [{ id: 'F1', file: 'a.mjs', find: 'true', replace: 'false', description: 'Break condition.', faultClass: 'other', producedBy: { producer: 'human' } }] }] }));
    const lines = [];
    expect(await claimsCommand({ projectDir: dir, values: { json: true, claims: custom }, version: 'test' }, { out: (s) => lines.push(s) })).toBe(0);
    const advisory = JSON.parse(lines.join('\n')).annotationAdvisory;
    expect(advisory.missingIds).toEqual(['B-1']);
    expect(advisory.notes.join('\n')).toContain('Preserve the original --claims argument');
    const status = computeStatus({ projectDir: dir, paths: { claims: custom, evidence: join(dir, 'absent-evidence'), provisional: join(dir, 'absent-provisional'), baseline: join(dir, 'absent-baseline') } });
    expect(status.notes.join('\n')).toContain('Preserve the original --claims argument');
    expect(status.next.action).toBe('probe');
  });
});
