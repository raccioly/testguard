// @req FR-08
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { computeChangedGate, changedFiles, detectChangedRef, detectLocalChangedRef, DEFAULT_EXCLUDES, renderGate } from '../src/gate/changed.mjs';
import { computeStatus, renderStatus } from '../src/status/status.mjs';
import { computeClaimedSurface } from '../src/status/surface.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { readSpecDoc } from '../src/evidence/writer.mjs';
import { main } from '../src/cli.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'known-answer');
const capture = () => { const lines = { out: [], err: [] }; return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } }; };

import {repo} from './helpers/gate-project.mjs';

const IGNORE = (pattern, extra = {}) => JSON.stringify({ schemaVersion: 1, entries: [{ kind: 'path', pattern, reason: 'Excused for the test scenario; a reviewer accepted it.', by: 'test', ...extra }] });

describe('gate --changed: claim coverage of a change', () => {
  let r;
  beforeEach(() => { r = repo(); });
  afterEach(() => rmSync(r.root, { recursive: true, force: true }));

  it('covers selected fault overrides, not an unused inherited claim defender', () => {
    const path = join(r.project, 'testguard.claims.json');
    const claims = JSON.parse(readFileSync(path, 'utf8'));
    const c = claims.claims[0];
    c.defendedBy = ['test/unused.test.mjs'];
    for (const f of c.faults) f.defendedBy = ['test/selected.test.mjs'];
    r.write('test/unused.test.mjs', '// unused\n');
    r.write('test/selected.test.mjs', '// selected\n');
    r.write('testguard.claims.json', JSON.stringify(claims));
    const doc = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true });
    expect(doc.covered).toContainEqual({ file: 'test/selected.test.mjs', by: 'defender', claimIds: [c.id] });
    expect(doc.uncovered.map((u) => u.file)).toContain('test/unused.test.mjs');
    expect(validate('gate', doc).errors).toEqual([]);
  });

  it('a change to a file that carries a fault, or to a test file that defends a claim, is covered', () => {
    r.write('src/redact.mjs', readFileSync(join(r.project, 'src/redact.mjs'), 'utf8') + '\n// touched\n');
    r.write('test/redact.test.mjs', readFileSync(join(r.project, 'test/redact.test.mjs'), 'utf8') + '\n// touched\n');
    const doc = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, toolVersion: 't' });
    expect(doc.exitCode).toBe(0);
    expect(doc.covered).toEqual(expect.arrayContaining([
      { file: 'src/redact.mjs', by: 'fault', claimIds: expect.arrayContaining(['REDACT-001', 'REDACT-003', 'DISCOVER-001']) },
      { file: 'test/redact.test.mjs', by: 'defender', claimIds: expect.arrayContaining(['REDACT-001', 'DISCOVER-001']) },
    ]));
    expect(doc.uncovered).toEqual([]);
  });

  it('a change that evaluates nothing passes with a note, and fails under --strict; an empty change passes', () => {
    r.write('README.md', '# changed\n');
    r.write('vitest.config.mjs', 'export default {};\n');
    const doc = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, toolVersion: 't' });
    expect(doc).toMatchObject({ changed: 2, evaluated: 0, exitCode: 0 });
    expect(doc.excluded).toEqual(expect.arrayContaining([{ file: 'README.md', by: 'non-source' }, { file: 'vitest.config.mjs', by: 'default:**/*.config.*' }]));
    const strict = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, strict: true, toolVersion: 't' });
    expect(strict.exitCode).toBe(1);
    expect(validate('gate', strict).errors).toEqual([]);
    r.commit();
    const empty = computeChangedGate({ projectDir: r.project, ref: 'HEAD', toolVersion: 't' });
    expect(empty).toMatchObject({ changed: 0, exitCode: 0 });
  });

  it('--exclude adds patterns; a deleted file is not a change; DEFAULT_EXCLUDES is the documented list', () => {
    r.write('src/generated/client.mjs', 'export const x = 1;\n');
    rmSync(join(r.project, 'src/export.mjs'));
    const doc = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, exclude: ['src/generated/**'], toolVersion: 't' });
    expect(doc.excluded).toEqual([{ file: 'src/generated/client.mjs', by: 'exclude:src/generated/**' }]);
    expect(doc.changed).toBe(1);
    expect(DEFAULT_EXCLUDES).toContain('**/fixtures/**');
    expect(DEFAULT_EXCLUDES).toContain('.testguard/**');
  });

  it('with no claims file every changed source file is uncovered, with no claim to point at', () => {
    rmSync(join(r.project, 'testguard.claims.json'));
    r.commit('drop claims');
    r.write('src/newfeature.mjs', 'export const f = () => 1;\n');
    const doc = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, toolVersion: 't' });
    expect(doc.uncovered).toEqual([{ file: 'src/newfeature.mjs', kind: 'source', suggestion: 'testguard scaffold src/newfeature.mjs' }]);
    expect(doc.exitCode).toBe(1);
  });

  it('delegates descendant projects visibly, evaluates the child separately, and restores ownership after marker removal', () => {
    r.write('backend/testguard.claims.json', JSON.stringify({ schemaVersion: 1, claims: [] }));
    r.write('backend/src/newfeature.mjs', 'export const f = () => 1;\n');
    r.write('backend-extra.mjs', 'export const g = () => 1;\n');
    const doc = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true });
    expect(doc.nested).toEqual([{ project: 'backend', files: ['backend/src/newfeature.mjs', 'backend/testguard.claims.json'] }]);
    expect(doc.uncovered.map((entry) => entry.file)).toEqual(['backend-extra.mjs']);
    expect(validate('gate', doc).errors).toEqual([]);
    expect(renderGate(doc)).toContain('child coverage has not been evaluated here');
    const status = computeStatus({ projectDir: r.project, changedRef: 'HEAD', includeDirty: true });
    expect(status.changes.nested).toEqual(doc.nested);
    expect(validate('status', status).errors).toEqual([]);
    expect(renderStatus(status)).toContain('testguard gate backend --changed HEAD --include-dirty');
    expect(computeClaimedSurface({ projectDir: r.project }).rankedUnclaimed.some((entry) => entry.file.startsWith('backend/'))).toBe(false);
    const child = computeChangedGate({ projectDir: join(r.project, 'backend'), ref: 'HEAD', includeDirty: true });
    expect(child.uncovered.map((entry) => entry.file)).toEqual(['src/newfeature.mjs']);
    rmSync(join(r.project, 'backend-extra.mjs'));
    expect(computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, strict: true }).exitCode).toBe(1);
    rmSync(join(r.project, 'backend/testguard.claims.json'));
    const restored = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true });
    expect(restored.nested).toBeUndefined();
    expect(restored.uncovered.map((entry) => entry.file)).toEqual(['backend/src/newfeature.mjs']);
  });

  it('invalid and symlinked descendant markers fail instead of hiding unclaimed files', () => {
    r.write('backend/src/newfeature.mjs', 'export const f = () => 1;\n');
    const marker = join(r.project, 'backend/testguard.claims.json');
    r.write('backend/testguard.claims.json', '{"schemaVersion":1,"claims":"broken"}');
    expect(() => computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true })).toThrow(/does not conform/);
    rmSync(marker);
    symlinkSync(join(r.project, 'testguard.claims.json'), marker);
    expect(() => computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true })).toThrow(/without symlink traversal/);
  });

  it('CLI: exit 1 with an UNCLAIMED line and a written gate.json; 0 once excused, printing the reliance; 2 on an unknown ref; 3 with no reference; --explain lists the defaults', async () => {
    r.write('src/newfeature.mjs', 'export const f = () => 1;\n');
    const a = capture();
    expect(await main(['gate', r.project, '--changed', 'HEAD', '--include-dirty'], a.io)).toBe(1);
    expect(a.lines.out.join('\n')).toMatch(/UNCLAIMED\s+src\/newfeature\.mjs\s+\(source, nearest claim REDACT-001\)/);
    expect(a.lines.out.join('\n')).toContain('testguard scaffold src/newfeature.mjs --claim REDACT-001');
    const written = readSpecDoc('gate', join(r.project, '.testguard', 'gate.json'));
    expect(written.exitCode).toBe(1);

    r.write('testguard.ignore.json', IGNORE('src/**'));
    const b = capture();
    expect(await main(['gate', r.project, '--changed', 'HEAD', '--include-dirty'], b.io)).toBe(0);
    expect(b.lines.out.join('\n')).toMatch(/excused\s+src\/newfeature\.mjs\s+by ignore "src\/\*\*"/);

    const c = capture();
    expect(await main(['gate', r.project, '--changed', 'no-such-ref'], c.io)).toBe(2);
    expect(c.lines.err.join('\n')).toMatch(/cannot resolve --changed no-such-ref/);

    const saved = { ...process.env };
    delete process.env.TESTGUARD_CHANGED_REF; delete process.env.GITHUB_BASE_REF; delete process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA; delete process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME;
    try {
      const d = capture();
      expect(await main(['gate', r.project], d.io)).toBe(3);
      expect(d.lines.err.join('\n')).toMatch(/--changed <ref>/);
      process.env.TESTGUARD_CHANGED_REF = 'HEAD';
      const e = capture();
      expect(await main(['gate', r.project, '--include-dirty', '--json'], e.io)).toBe(0);
      expect(JSON.parse(e.lines.out.join('\n')).ref).toBe('HEAD');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }

    const f = capture();
    expect(await main(['gate', '--explain'], f.io)).toBe(0);
    for (const g of DEFAULT_EXCLUDES) expect(f.lines.out.join('\n')).toContain(g);
    expect(existsSync(join(r.project, '.testguard', 'gate.json'))).toBe(true);
  });
});
