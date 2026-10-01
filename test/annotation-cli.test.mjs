import { afterEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../src/cli.mjs';
import { validate } from '../spec/lib/validate.mjs';

const failures = vi.hoisted(() => ({ partialWrite: false, openTarget: false, recovery: false }));
vi.mock('node:fs', async (original) => {
  const actual = await original();
  return { ...actual,
    openSync: (path, flags, mode) => {
      if (failures.openTarget && String(path).replaceAll('\\', '/').endsWith('/src/a.mjs') && (flags & actual.constants.O_RDWR)) throw new Error(`EACCES: permission denied, open '${path}'`);
      return actual.openSync(path, flags, mode);
    },
    mkdtempSync: (...args) => {
      if (failures.recovery && String(args[0]).includes('testguard-annotation-recovery-')) throw new Error(`EACCES: permission denied, mkdir '${args[0]}'`);
      return actual.mkdtempSync(...args);
    },
    writeSync: (fd, buffer, offset, length, position) => {
    if (failures.partialWrite) {
      failures.partialWrite = false;
      actual.writeSync(fd, buffer, offset, 1, position);
      throw new Error('controlled write interruption');
    }
    return actual.writeSync(fd, buffer, offset, length, position);
  } };
});
const roots = [];
afterEach(() => { failures.partialWrite = false; failures.openTarget = false; failures.recovery = false; for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-annotation-cli-')); roots.push(dir);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/a.mjs'), 'export const allowed = true;\n');
  const claim = (id) => ({ id, statement: 'The intended condition holds.', severity: 'high', source: { kind: 'manual' }, producedBy: { producer: 'human' }, faults: [{ id: 'F1', description: 'Break condition.', faultClass: 'other', file: 'src/a.mjs', find: 'true', replace: 'false', producedBy: { producer: 'human' } }] });
  const claims = { schemaVersion: 1, claims: [claim('A-1'), claim('B-1')] };
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(claims));
  return { dir, claims };
}
async function run(args) {
  const out = [], err = [];
  const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
describe('explicit annotation CLI', () => {
  it('places on the actual target despite lexical links elsewhere or inside target strings', async () => {
    const { dir } = project();
    const target = 'const label = "@claim A-1";\nexport const allowed = true;\n';
    const elsewhere = '// @claim A-1\n// @claim B-1\nexport const unrelated = 1;\n';
    writeFileSync(join(dir, 'src/a.mjs'), target);
    writeFileSync(join(dir, 'src/elsewhere.mjs'), elsewhere);
    const originalClaims = readFileSync(join(dir, 'testguard.claims.json'), 'utf8');
    const inspection = await run(['claims', dir, '--json']);
    expect(inspection.code).toBe(0);
    expect(JSON.parse(inspection.out).annotationAdvisory.missingIds).toEqual([]);
    const preview = JSON.parse((await run(['claims', dir, '--annotate', '--claim', 'A-1', '--json'])).out);
    expect(preview.targets).toEqual([{ file: 'src/a.mjs', claimIds: ['A-1'], action: 'add' }]);
    expect(readFileSync(join(dir, 'src/a.mjs'), 'utf8')).toBe(target);
    const applied = await run(['claims', dir, '--annotate', '--apply', '--claim', 'A-1', '--json']);
    expect(applied.code).toBe(0);
    const doc = JSON.parse(applied.out); roots.push(doc.outcome.recoveryDir);
    expect(validate('annotations', doc).errors).toEqual([]);
    expect(doc.outcome.changed).toEqual(['src/a.mjs']);
    expect(readFileSync(join(dir, 'src/a.mjs'), 'utf8')).toBe('// @claim A-1\n' + target);
    expect(readFileSync(join(dir, 'src/elsewhere.mjs'), 'utf8')).toBe(elsewhere);
    expect(readFileSync(join(dir, 'testguard.claims.json'), 'utf8')).toBe(originalClaims);
    expect(existsSync(join(dir, '.testguard'))).toBe(false);
    const repeat = JSON.parse((await run(['claims', dir, '--annotate', '--claim', 'A-1', '--json'])).out);
    expect(repeat.targets[0].action).toBe('unchanged');
  });
  it('previews without any writes, deduplicates pairs and omits internal bytes', async () => {
    const { dir } = project();
    const result = await run(['claims', dir, '--annotate', '--json']);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out);
    expect(validate('annotations', doc).errors).toEqual([]);
    expect(doc).toMatchObject({ mode: 'preview', state: 'preview', selected: ['A-1', 'B-1'], targets: [{ file: 'src/a.mjs', claimIds: ['A-1', 'B-1'], action: 'add' }] });
    expect(result.out).not.toContain('export const');
    expect(readFileSync(join(dir, 'src/a.mjs'), 'utf8')).toBe('export const allowed = true;\n');
    expect(existsSync(join(dir, '.testguard-annotations.lock'))).toBe(false);
    expect(existsSync(join(dir, '.testguard'))).toBe(false);
  });
  it('applies only explicit selection, preserves claims and is idempotent', async () => {
    const { dir } = project();
    const original = readFileSync(join(dir, 'testguard.claims.json'), 'utf8');
    for (let i = 0; i < 2; i++) {
      const result = await run(['claims', dir, '--annotate', '--apply', '--claim', 'A-1', '--json']);
      expect(result.code).toBe(0);
      const doc = JSON.parse(result.out); roots.push(doc.outcome.recoveryDir);
      expect(validate('annotations', doc).errors).toEqual([]);
      expect(doc.state).toBe('applied');
      expect(doc.outcome.changed).toEqual(i ? [] : ['src/a.mjs']);
      expect(doc.outcome.lockRelease.released).toBe(true);
    }
    expect(readFileSync(join(dir, 'src/a.mjs'), 'utf8')).toBe('// @claim A-1\nexport const allowed = true;\n');
    expect(readFileSync(join(dir, 'testguard.claims.json'), 'utf8')).toBe(original);
    expect(existsSync(join(dir, '.testguard'))).toBe(false);
  });
  it('refuses all writes when a later target cannot be admitted', async () => {
    const { dir, claims } = project();
    claims.claims[1].faults[0].file = 'src/missing.mjs';
    writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(claims));
    const result = await run(['claims', dir, '--annotate', '--apply', '--json']);
    expect(result.code).toBe(2);
    const doc = JSON.parse(result.out);
    expect(doc.state).toBe('refused');
    expect(doc.outcome.touched).toEqual([]);
    expect(readFileSync(join(dir, 'src/a.mjs'), 'utf8')).toBe('export const allowed = true;\n');
    expect(existsSync(join(dir, '.testguard-annotations.lock'))).toBe(false);
  });
  it.each([
    ['--apply'], ['--annotate', '--claim', ''], ['--annotate', '--claim', 'A-1,'],
    ['--annotate', '--claim', 'UNKNOWN-1'], ['--annotate', '--cost'],
    ['--annotate', '--check-anchors'], ['--annotate', '--out', 'src/a.mjs'],
    ['--annotate', '--include-dirty'], ['--annotate', '--in-place'],
    ['--annotate', '--ci-evidence', 'private.json'], ['--annotate', '--save-paths'],
    ['--annotate', '--explain'], ['--annotate', '--runner', 'auto'],
    ['--annotate', '--budget', '120000'], ['--annotate', '--concern', 'SAVE-PERSISTS'],
  ])('rejects unsafe or ambiguous options %j', async (...options) => {
    const { dir } = project();
    expect((await run(['claims', dir, ...options])).code).toBe(3);
    expect(readFileSync(join(dir, 'src/a.mjs'), 'utf8')).toBe('export const allowed = true;\n');
  });
  it('rejects authoring flags on another command and documents explicit apply', async () => {
    const { dir } = project();
    expect((await run(['status', dir, '--annotate'])).code).toBe(3);
    const help = await run(['claims', '--help']);
    expect(help.out).toContain('--annotate');
    expect(help.out).toContain('--apply');
  });
  it('reports a held lock as an authoring refusal, never as a successful apply', async () => {
    const { dir } = project();
    writeFileSync(join(dir, '.testguard-annotations.lock'), 'other writer');
    const result = await run(['claims', dir, '--annotate', '--apply', '--json']);
    expect(result.code).toBe(2);
    const doc = JSON.parse(result.out);
    expect(validate('annotations', doc).errors).toEqual([]);
    expect(doc).toMatchObject({ state: 'refused', outcome: { touched: [], changed: [], failed: [{ stage: 'preparation' }] } });
    expect(readFileSync(join(dir, '.testguard-annotations.lock'), 'utf8')).toBe('other writer');
    expect(readFileSync(join(dir, 'src/a.mjs'), 'utf8')).toBe('export const allowed = true;\n');
  });
  it('refuses malformed and oversized claims before source writes', async () => {
    const { dir } = project();
    for (const bytes of ['{}', 'x'.repeat(2 * 1024 * 1024 + 1)]) {
      writeFileSync(join(dir, 'testguard.claims.json'), bytes);
      const result = await run(['claims', dir, '--annotate', '--apply', '--json']);
      expect(result.code).toBe(2);
      expect(result.err).toContain('annotation input refused');
      expect(result.err).not.toContain('bug in testguard');
      expect(readFileSync(join(dir, 'src/a.mjs'), 'utf8')).toBe('export const allowed = true;\n');
      expect(existsSync(join(dir, '.testguard-annotations.lock'))).toBe(false);
    }
  });
  it('renders the same explicit read-only authoring boundary for humans', async () => {
    const { dir } = project();
    const result = await run(['claims', dir, '--annotate', '--claim', 'A-1,B-1']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('file-level authoring, not verification');
    expect(result.out).toContain('No files changed');
  });
  it('explicitly refuses a reserved non-injection method without a source file', async () => {
    const { dir, claims } = project();
    claims.claims[1].faults = [{ id: 'P1', description: 'Reserved assertion method.', method: 'assertion', producedBy: { producer: 'human' } }];
    writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(claims));
    const result = await run(['claims', dir, '--annotate', '--apply', '--json']);
    expect(result.code).toBe(2);
    const doc = JSON.parse(result.out);
    expect(validate('annotations', doc).errors).toEqual([]);
    expect(doc.refused).toContainEqual(expect.objectContaining({ claimIds: ['B-1'], reason: 'unsupported-method' }));
    expect(doc.outcome.touched).toEqual([]);
    expect(readFileSync(join(dir, 'src/a.mjs'), 'utf8')).toBe('export const allowed = true;\n');
  });
  it('reports an actual interrupted descriptor write as partial and retains originals', async () => {
    const { dir } = project();
    failures.partialWrite = true;
    const result = await run(['claims', dir, '--annotate', '--apply', '--json']);
    expect(result.code).toBe(2);
    const doc = JSON.parse(result.out); roots.push(doc.outcome.recoveryDir);
    expect(validate('annotations', doc).errors).toEqual([]);
    expect(doc).toMatchObject({ state: 'partial', outcome: { changed: [], touched: ['src/a.mjs'], failed: [{ file: 'src/a.mjs', stage: 'source-write' }], lockRelease: { released: true } } });
    expect(readFileSync(join(doc.outcome.recoveryDir, '0.original'), 'utf8')).toBe('export const allowed = true;\n');
    expect(readFileSync(join(dir, 'src/a.mjs'), 'utf8')).toBe('/xport const allowed = true;\n');
    expect(existsSync(join(doc.outcome.recoveryDir, 'started.json'))).toBe(true);
  });
  it.each(['target-open', 'recovery-creation'])('does not leak absolute source/input paths after %s failure', async (stage) => {
    const { dir } = project();
    failures.openTarget = stage === 'target-open'; failures.recovery = stage === 'recovery-creation';
    const result = await run(['claims', dir, '--annotate', '--apply', '--json']);
    expect(result.code).toBe(2);
    const doc = JSON.parse(result.out);
    if (doc.outcome.recoveryDir) roots.push(doc.outcome.recoveryDir);
    expect(validate('annotations', doc).errors).toEqual([]);
    expect(doc.state).toBe('refused');
    expect(doc.outcome.failed).toHaveLength(1);
    expect(doc.outcome.failed[0].reason).not.toContain(dir);
    expect(doc.outcome.failed[0].reason).not.toContain('EACCES:');
    expect(doc.outcome.failed[0].reason).not.toContain("open '");
    expect(doc.outcome.failed[0].reason).not.toContain("mkdir '");
    expect(readFileSync(join(dir, 'src/a.mjs'), 'utf8')).toBe('export const allowed = true;\n');
  });
});
