// @req FR-03
// Issue #236: a replacement that parses but does not type-check is a bad fault,
// not a detection. Every expectation is in fixtures/known-answer-typescript/
// expected.json, verified by applying each fault by hand and running tsc and the
// defenders.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { checkAnchors } from '../src/claims/anchors.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { main } from '../src/cli.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { PreconditionError } from '../src/probe/worktree.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TS_FIXTURE = join(ROOT, 'fixtures', 'known-answer-typescript');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeText = (path, text) => writeFileSync(path, text);

/**
 * The fixture carries its own dependencies (typescript and vitest), installed in
 * its directory, so the tool's package.json stays untouched. Unlike the
 * Playwright fixture this is never skipped: a type check that quietly does not
 * run would let the suite pass without ever exercising it.
 */
function requireInstalledFixture() {
  for (const pkg of ['typescript', 'vitest']) {
    if (!existsSync(join(TS_FIXTURE, 'node_modules', pkg, 'package.json'))) {
      throw new Error(`fixtures/known-answer-typescript is not installed (${pkg} is missing): run \`npm ci --prefix fixtures/known-answer-typescript\`. This suite does not skip.`);
    }
  }
}

/** A committed copy of the fixture in a temp directory, node_modules linked in. `edit(dir)` runs before the commit. */
function typescriptProject({ edit } = {}) {
  requireInstalledFixture();
  const dir = mkdtempSync(join(tmpdir(), 'testguard-ts-'));
  cpSync(TS_FIXTURE, dir, { recursive: true, filter: (src) => !/node_modules|\.testguard/.test(src) });
  symlinkSync(join(TS_FIXTURE, 'node_modules'), join(dir, 'node_modules'), 'dir');
  edit?.(dir);
  const git = (...args) => {
    const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=f@example.invalid', '-c', 'user.name=f', ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'fixture');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const expected = readJson(join(TS_FIXTURE, 'expected.json'));
const run = (project, extra = {}) => probe({ projectDir: project.dir, claims: loadClaims(join(project.dir, 'testguard.claims.json')), confirmRuns: expected.confirmRuns, escalate: false, budgetMs: 120_000, toolVersion: 'test', ...extra });
const byId = (evidence) => Object.fromEntries(evidence.records.map((r) => [`${r.claim.id}/${r.subject.id}`, r]));

describe('probe --typecheck reproduces the TypeScript fixture', () => {
  let project;
  let evidence;
  beforeAll(async () => {
    project = typescriptProject();
    evidence = await run(project, { typecheck: '' });
  }, 600_000);
  afterAll(() => project?.cleanup());

  it('yields every hand-verified verdict and reason', () => {
    const actual = Object.fromEntries(Object.entries(byId(evidence)).map(([k, r]) => [k, { verdict: r.verdict, reason: r.detail.reason }]));
    const wanted = Object.fromEntries(Object.entries(expected.expected).map(([k, v]) => [k, { verdict: v.verdict, reason: v.reason ?? actual[k]?.reason }]));
    expect(actual).toEqual(wanted);
  });

  it('a replacement that does not type-check spends zero test runs and names the first diagnostic', () => {
    for (const key of ['TS-STRING/F1', 'TS-SIGNATURE/F1']) {
      const record = byId(evidence)[key];
      expect(record.detail.baselineRuns).toEqual([]);
      expect(record.detail.probeRuns).toEqual([]);
      expect(record.detail.typecheck).toBe('diagnostics');
      expect(record.detail.message).toBe(expected.expected[key].diagnostic);
    }
  });

  it('records how each fault was checked: clean, diagnostics or not applicable', () => {
    const records = byId(evidence);
    for (const [key, want] of Object.entries(expected.expected)) expect(records[key].detail.typecheck, key).toBe(want.typecheck);
  });

  it('a fault that type-checks after one that did not carries none of its diagnostics', () => {
    const total = byId(evidence)['TS-TOTAL/F1'];
    expect(total.detail.message).toBeUndefined();
    expect(total.detail.reason).toBeUndefined();
    expect(total.detail.typecheck).toBe('clean');
  });

  it('names the checker in run.typecheck and the document conforms to the spec', () => {
    expect(evidence.run.typecheck).toEqual({ commandHash: expect.stringMatching(/^[0-9a-f]{64}$/), version: '5.9.3' });
    expect(validate('evidence', evidence)).toEqual({ ok: true, errors: [] });
  });

  it('leaves the project as committed, and the scratch build-info out of it', () => {
    expect(existsSync(join(project.dir, 'tsconfig.tsbuildinfo'))).toBe(false);
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: project.dir, encoding: 'utf8' }).stdout).toBe('');
  });
});

describe('without --typecheck the same faults are probed as before', () => {
  it('a string result is a kill and an extra parameter a survivor, with no type-check fields', async () => {
    const project = typescriptProject();
    try {
      const evidence = await run(project, { only: ['TS-STRING', 'TS-SIGNATURE'] });
      const records = byId(evidence);
      for (const [key, want] of Object.entries(expected.expectedWithoutTypecheck)) expect(records[key].verdict, key).toBe(want.verdict);
      expect(evidence.run.typecheck).toBeUndefined();
      expect(evidence.records.every((r) => r.detail.typecheck === undefined)).toBe(true);
    } finally { project.cleanup(); }
  }, 300_000);
});

describe('a dirty baseline type check is a precondition error', () => {
  it('names the first diagnostic and writes nothing', async () => {
    const project = typescriptProject({ edit: (dir) => writeText(join(dir, 'src', 'extra.ts'), 'export const broken: number = "not a number";\n') });
    try {
      // One run through the bin: exit 2 is how a PreconditionError leaves the process, and stderr carries its message.
      const cli = spawnSync(process.execPath, [join(ROOT, 'cli', 'testguard.mjs'), 'probe', project.dir, '--typecheck', '--quiet'], { encoding: 'utf8' });
      expect(cli.status).toBe(2);
      expect(cli.stderr).toMatch(/does not type-check[\s\S]*src\/extra\.ts\(1,14\): error TS2322/);
      expect(existsSync(join(project.dir, '.testguard', 'evidence.json'))).toBe(false);
    } finally { project.cleanup(); }
  }, 300_000);
});

describe('the command line', () => {
  it('--typecheck (bare) and --typecheck=<cmd> both reach fault-invalid on the fixture, and a custom command is recorded', () => {
    const project = typescriptProject();
    try {
      const bin = join(ROOT, 'cli', 'testguard.mjs');
      const bare = spawnSync(process.execPath, [bin, 'probe', project.dir, '--typecheck', '--quiet', '--no-escalate', '--claim', 'TS-STRING,TS-SIGNATURE'], { encoding: 'utf8' });
      expect(bare.status).toBe(1); // fault-invalid gates (GATE-SEMANTICS): a bad fault is a claim not yet proven
      const evidence = readJson(join(project.dir, '.testguard', 'evidence-partial.json'));
      expect(evidence.records.map((r) => r.verdict)).toEqual(['fault-invalid', 'fault-invalid']);
      const tsc = join(TS_FIXTURE, 'node_modules', 'typescript', 'bin', 'tsc');
      const custom = spawnSync(process.execPath, [bin, 'probe', project.dir, `--typecheck=${process.execPath} ${tsc} --noEmit -p tsconfig.json`, '--quiet', '--no-escalate', '--no-reuse', '--claim', 'TS-STRING'], { encoding: 'utf8' });
      expect(custom.status).toBe(1);
      const second = readJson(join(project.dir, '.testguard', 'evidence-partial.json'));
      expect(second.records[0]).toMatchObject({ verdict: 'fault-invalid', detail: { reason: 'replacement-does-not-typecheck' } });
      expect(second.run.typecheck.commandHash).not.toBe(evidence.run.typecheck.commandHash);
    } finally { project.cleanup(); }
  }, 300_000);
});

const expectedAnchors = readJson(join(TS_FIXTURE, 'expected.json')).expected;
const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, io: { out: (l) => lines.out.push(l), err: (l) => lines.err.push(l) } };
};

describe('claims --check-anchors --typecheck', () => {
  it('flags a replacement that parses but does not type-check, and leaves the project alone', async () => {
    const project = typescriptProject();
    try {
      const report = await checkAnchors(project.dir, loadClaims(join(project.dir, 'testguard.claims.json')), { typecheck: '' });
      const byKey = Object.fromEntries(report.results.map((r) => [`${r.claimId}/${r.faultId}`, r]));
      for (const [key, want] of Object.entries(expectedAnchors)) {
        const r = byKey[key];
        expect(r.status, key).toBe(want.verdict === 'fault-invalid' ? 'fault-invalid' : 'ok');
        expect(r.typecheck.status, key).toBe(want.typecheck);
        if (want.diagnostic) expect(r.typecheck.message, key).toBe(want.diagnostic);
      }
      expect(report).toMatchObject({ checked: 7, ok: 5, invalid: 2 });
      expect(spawnSync('git', ['status', '--porcelain'], { cwd: project.dir, encoding: 'utf8' }).stdout).toBe('');
    } finally { project.cleanup(); }
  }, 120_000);

  it('judges the working tree, and refuses a tree that already fails the check', async () => {
    const project = typescriptProject();
    try {
      writeText(join(project.dir, 'src', 'extra.ts'), 'export const broken: number = "not a number";\n'); // uncommitted
      const failure = await checkAnchors(project.dir, loadClaims(join(project.dir, 'testguard.claims.json')), { typecheck: '' }).then(() => undefined, (e) => e);
      expect(failure).toBeInstanceOf(PreconditionError);
      expect(failure.message).toMatch(/src\/extra\.ts\(1,14\): error TS2322/);
    } finally { project.cleanup(); }
  }, 120_000);

  it('without --typecheck the same replacements are anchor-only, as before', async () => {
    const project = typescriptProject();
    try {
      const report = await checkAnchors(project.dir, loadClaims(join(project.dir, 'testguard.claims.json')));
      expect(report).toMatchObject({ checked: 7, ok: 7, invalid: 0 });
      expect(report.results.every((r) => r.typecheck === undefined)).toBe(true);
    } finally { project.cleanup(); }
  }, 60_000);

});
