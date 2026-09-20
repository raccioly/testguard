// @req FR-08
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { computeChangedGate, changedFiles, detectChangedRef, detectLocalChangedRef, DEFAULT_EXCLUDES } from '../src/gate/changed.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { readSpecDoc } from '../src/evidence/writer.mjs';
import { main } from '../src/cli.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'known-answer');
const capture = () => { const lines = { out: [], err: [] }; return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } }; };

/** A copy of the fixture as its own repository, with a helper to commit. */
function repo({ nested = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-gate-')));
  const project = nested ? join(root, 'pkg') : root;
  if (nested) mkdirSync(project);
  cpSync(FIXTURE, project, { recursive: true, filter: (s) => !/node_modules|\.flake-counter|\.testguard/.test(s) });
  // This suite exercises change coverage, not the known-answer fixture's
  // deliberate missing/ambiguous anchor cases. Give status a healthy base.
  const claimsPath = join(project, 'testguard.claims.json');
  const claims = JSON.parse(readFileSync(claimsPath, 'utf8'));
  const anchors = claims.claims.find((c) => c.id === 'REDACT-005').faults;
  anchors[0].find = 'if (rule.id === id) return rule;';
  anchors[0].replace = 'if (rule.id === id) return rules[0];';
  anchors[1].find = '  return null;\n}\n\n/** Compile all rules.';
  anchors[1].replace = '  return rules[0];\n}\n\n/** Compile all rules.';
  delete anchors[1].expectHits;
  writeFileSync(claimsPath, JSON.stringify(claims, null, 2) + '\n');
  const g = (...args) => {
    const r = spawnSync('git', ['-c', 'user.email=g@example.invalid', '-c', 'user.name=g', ...args], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  g('init', '-q');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const commit = (msg = 'change') => { g('add', '-A'); g('commit', '-q', '-m', msg); };
  const write = (rel, text) => { mkdirSync(dirname(join(project, rel)), { recursive: true }); writeFileSync(join(project, rel), text); };
  return { root, project, g, commit, write };
}

const IGNORE = (pattern, extra = {}) => JSON.stringify({ schemaVersion: 1, entries: [{ kind: 'path', pattern, reason: 'Excused for the test scenario; a reviewer accepted it.', by: 'test', ...extra }] });

describe('gate --changed: claim coverage of a change', () => {
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

  it('a new test file that defends no claim is uncovered as kind test — a suite that grows without a claim is the authorship trap', () => {
    r.write('test/orphan.test.mjs', "import { it, expect } from 'vitest';\nit('x', () => expect(1).toBe(1));\n");
    const doc = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, toolVersion: 't' });
    expect(doc.exitCode).toBe(1);
    expect(doc.uncovered).toEqual([expect.objectContaining({ file: 'test/orphan.test.mjs', kind: 'test' })]);
    expect(doc.uncovered[0].suggestion).toMatch(/^add test\/orphan\.test\.mjs to the defendedBy/);
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

describe('detectChangedRef', () => {
  it('prefers the explicit variable, then GitHub, then GitLab, and never guesses', () => {
    expect(detectChangedRef({ TESTGUARD_CHANGED_REF: 'origin/develop', GITHUB_BASE_REF: 'main' })).toEqual({ ref: 'origin/develop', from: 'TESTGUARD_CHANGED_REF' });
    expect(detectChangedRef({ GITHUB_BASE_REF: 'main' })).toEqual({ ref: 'origin/main', from: 'GITHUB_BASE_REF' });
    expect(detectChangedRef({ CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'release' })).toEqual({ ref: 'origin/release', from: 'CI_MERGE_REQUEST_TARGET_BRANCH_NAME' });
    // GitLab: the exact diff base sha wins over the branch name (no fetch needed on a shallow clone); an all-zero sha is ignored
    expect(detectChangedRef({ CI_MERGE_REQUEST_DIFF_BASE_SHA: 'a'.repeat(40), CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'release' })).toEqual({ ref: 'a'.repeat(40), from: 'CI_MERGE_REQUEST_DIFF_BASE_SHA' });
    expect(detectChangedRef({ CI_MERGE_REQUEST_DIFF_BASE_SHA: '0'.repeat(40), CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'release' })).toEqual({ ref: 'origin/release', from: 'CI_MERGE_REQUEST_TARGET_BRANCH_NAME' });
    expect(detectChangedRef({})).toBeNull();
  });
});

describe('detectLocalChangedRef', () => {
  it('uses a remote default from a feature branch, but never the current branch\'s same-name remote', () => {
    const r = repo();
    try {
      r.g('branch', '-M', 'main');
      r.g('remote', 'add', 'origin', 'https://example.invalid/repo.git');
      r.g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      r.g('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
      expect(detectLocalChangedRef(r.project)).toBeNull();

      r.g('switch', '-q', '-c', 'feature');
      r.g('update-ref', 'refs/remotes/origin/feature', 'HEAD');
      r.g('branch', '--set-upstream-to', 'origin/feature');
      expect(detectLocalChangedRef(r.project)).toEqual({ ref: 'origin/main', from: 'remote default branch' });

      r.g('update-ref', '-d', 'refs/remotes/origin/main');
      expect(detectLocalChangedRef(r.project)).toBeNull();
      r.g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      r.g('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
      expect(detectLocalChangedRef(r.project)).toBeNull();
      r.g('branch', '--set-upstream-to', 'origin/main');
      expect(detectLocalChangedRef(r.project)).toEqual({ ref: 'origin/main', from: 'branch upstream' });
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  it('makes a bare gate work in an ordinary clone and says how the base was chosen', async () => {
    const r = repo();
    const saved = { ...process.env };
    try {
      delete process.env.TESTGUARD_CHANGED_REF; delete process.env.GITHUB_BASE_REF; delete process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA; delete process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME;
      r.g('branch', '-M', 'main');
      r.g('remote', 'add', 'origin', 'https://example.invalid/repo.git');
      r.g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      r.g('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
      r.g('switch', '-q', '-c', 'feature');
      r.write('src/newfeature.mjs', 'export const f = () => 1;\n');
      const a = capture();
      expect(await main(['gate', r.project, '--include-dirty'], a.io)).toBe(1);
      expect(a.lines.err).toEqual(['gate: comparing against origin/main (remote default branch)']);
      expect(a.lines.out.join('\n')).toMatch(/UNCLAIMED\s+src\/newfeature\.mjs/);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      rmSync(r.root, { recursive: true, force: true });
    }
  });
});

describe('resolveChangedRef / withChangedRef', () => {
  it('an explicit reference is required: failure propagates; a detected one degrades to a warning and no measurement', async () => {
    const { resolveChangedRef, withChangedRef } = await import('../src/gate/changed.mjs');
    const { GitError } = await import('../src/git.mjs');
    const boom = () => { throw new GitError('cannot resolve --changed nope: fatal. In CI, check out with full history'); };
    expect(resolveChangedRef({ explicit: 'origin/x', env: { GITHUB_BASE_REF: 'main' } })).toEqual({ ref: 'origin/x', from: '--changed', required: true });
    expect(resolveChangedRef({ env: {} })).toBeNull();
    expect(() => withChangedRef({ ref: 'nope', from: '--changed', required: true }, (ref) => (ref ? boom() : 'none'))).toThrow(GitError);
    const warnings = [];
    expect(withChangedRef({ ref: 'origin/main', from: 'GITHUB_BASE_REF', required: false }, (ref) => (ref ? boom() : 'none'), (m) => warnings.push(m))).toBe('none');
    expect(warnings[0]).toMatch(/change coverage skipped: origin\/main \(from GITHUB_BASE_REF\)/);
    expect(() => withChangedRef({ ref: 'origin/main', from: 'GITHUB_BASE_REF', required: false }, () => { throw new TypeError('bug'); })).toThrow(TypeError);
    expect(withChangedRef(null, (ref) => ref ?? 'none')).toBe('none');
  });

  it('status in a CI-like environment on a directory with no base branch still answers, with a warning on stderr', async () => {
    const r = repo();
    const saved = { ...process.env };
    try {
      process.env.GITHUB_BASE_REF = 'main'; // origin/main does not exist in the scratch repo
      const a = capture();
      expect(await main(['status', r.project, '--json'], a.io)).toBe(2); // unprobed → 2
      expect(JSON.parse(a.lines.out.join('\n')).state).toBe('unprobed');
      expect(a.lines.err.join('\n')).toMatch(/change coverage skipped: origin\/main \(from GITHUB_BASE_REF\)/);
      const b = capture();
      expect(await main(['status', r.project, '--json', '--changed', 'origin/main'], b.io)).toBe(2);
      expect(b.lines.err.join('\n')).toMatch(/cannot resolve --changed origin\/main/);
      expect(b.lines.out).toEqual([]);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      rmSync(r.root, { recursive: true, force: true });
    }
  });
});
