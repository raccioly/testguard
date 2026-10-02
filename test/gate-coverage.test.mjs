// @req FR-08
// Focused change-coverage defenders; gate.test.mjs retains integration checks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeChangedGate, changedFiles } from '../src/gate/changed.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { repo } from './helpers/gate-project.mjs';

const IGNORE = (pattern, extra = {}) => JSON.stringify({ schemaVersion: 1, entries: [{ kind: 'path', pattern, reason: 'Excused for the test scenario; a reviewer accepted it.', by: 'test', ...extra }] });

describe('focused gate change coverage', () => {
  let r;
  beforeEach(() => { r = repo(); });
  afterEach(() => rmSync(r.root, { recursive: true, force: true }));

  it('a new source file with no claim is uncovered, points at the same-directory claim, and exits 1; the document conforms', () => {
    r.write('src/newfeature.mjs', 'export const f = () => 1;\n');
    const doc = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, toolVersion: 't' });
    expect(validate('gate', doc).errors).toEqual([]);
    expect(doc).toMatchObject({ changed: 1, evaluated: 1, exitCode: 1 });
    expect(doc.uncovered).toEqual([{ file: 'src/newfeature.mjs', kind: 'source', nearestClaimId: 'REDACT-001', suggestion: 'testguard scaffold src/newfeature.mjs --claim REDACT-001' }]);
    // committed, measured against the parent: same answer
    r.commit();
    const committed = computeChangedGate({ projectDir: r.project, ref: 'HEAD~1', toolVersion: 't' });
    expect(committed.uncovered.map((u) => u.file)).toEqual(['src/newfeature.mjs']);
    expect(committed.exitCode).toBe(1);
  });

  it('an ignore entry with a reason excuses the file and is reported as relied upon; once expired it excuses nothing', () => {
    r.write('src/newfeature.mjs', 'export const f = () => 1;\n');
    r.write('testguard.ignore.json', IGNORE('src/newfeature.mjs', { expires: '2999-01-01T00:00:00Z' }));
    const ok = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, toolVersion: 't' });
    expect(ok.exitCode).toBe(0);
    expect(ok.covered).toEqual([{ file: 'src/newfeature.mjs', by: 'ignore', pattern: 'src/newfeature.mjs' }]);
    expect(ok.reliedOn).toEqual([expect.objectContaining({ pattern: 'src/newfeature.mjs', files: ['src/newfeature.mjs'], expires: '2999-01-01T00:00:00Z' })]);
    expect(validate('gate', ok).errors).toEqual([]);

    r.write('testguard.ignore.json', IGNORE('src/newfeature.mjs', { expires: '2020-01-01T00:00:00Z' }));
    const expired = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, toolVersion: 't' });
    expect(expired.exitCode).toBe(1);
    expect(expired.uncovered.map((u) => u.file)).toEqual(['src/newfeature.mjs']);
    expect(expired.reliedOn).toEqual([]);
    expect(expired.expired).toEqual([expect.objectContaining({ pattern: 'src/newfeature.mjs', files: ['src/newfeature.mjs'] })]);
    expect(validate('gate', expired).errors).toEqual([]);
  });

  it('a new test file that defends no claim is uncovered as kind test — a suite that grows without a claim is the authorship trap', () => {
    r.write('test/orphan.test.mjs', "import { it, expect } from 'vitest';\nit('x', () => expect(1).toBe(1));\n");
    const doc = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, toolVersion: 't' });
    expect(doc.exitCode).toBe(1);
    expect(doc.uncovered).toEqual([expect.objectContaining({ file: 'test/orphan.test.mjs', kind: 'test' })]);
    expect(doc.uncovered[0].suggestion).toMatch(/^add test\/orphan\.test\.mjs to the defendedBy/);
  });

  it('a project nested in a larger repository sees only its own files, as project-relative paths', () => {
    const n = repo({ nested: true });
    try {
      n.write('src/newfeature.mjs', 'export const f = () => 1;\n');
      writeFileSync(join(n.root, 'other.mjs'), 'export const y = 2;\n');
      const doc = computeChangedGate({ projectDir: n.project, ref: 'HEAD', includeDirty: true, toolVersion: 't' });
      expect(doc.changed).toBe(1);
      expect(doc.uncovered.map((u) => u.file)).toEqual(['src/newfeature.mjs']);
      const { files } = changedFiles({ root: n.root, ref: 'HEAD', includeDirty: true });
      expect(files).toEqual(['other.mjs', 'pkg/src/newfeature.mjs']);
    } finally {
      rmSync(n.root, { recursive: true, force: true });
    }
  });

});
