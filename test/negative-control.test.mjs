// @req FR-03
// @req NFR-06
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { classify } from '../src/probe/classify.mjs';
import { probe } from '../src/probe/probe.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { RUNNERS } from '../src/probe/runners/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('classify — the negative control is consulted at exactly one point', () => {
  const base = { defenders: ['t'], anchor: { status: 'ok' }, baselineRuns: [{ outcome: 'pass' }], confirmRuns: 1 };
  const passed = [{ outcome: 'pass', assertionFailures: 0, timeouts: 0 }];
  const killed = [{ outcome: 'fail', assertionFailures: 1, timeouts: 0 }];

  it('downgrades a survivor whose subject is never executed', () => {
    expect(classify({ ...base, probeRuns: passed, subjectReached: false }))
      .toEqual({ verdict: 'unverifiable', reason: 'subject-not-executed' });
  });

  it('leaves the survivor alone when the subject is executed', () => {
    expect(classify({ ...base, probeRuns: passed, subjectReached: true })).toEqual({ verdict: 'survived' });
  });

  it('leaves the survivor alone when the control was not run at all', () => {
    // A runner with no fatalEdit reports nothing, and nothing is not evidence.
    expect(classify({ ...base, probeRuns: passed })).toEqual({ verdict: 'survived' });
    expect(classify({ ...base, probeRuns: passed, subjectReached: undefined })).toEqual({ verdict: 'survived' });
  });

  it('never asks about a kill — a kill already proves the defenders reached the code', () => {
    expect(classify({ ...base, probeRuns: killed, subjectReached: false })).toEqual({ verdict: 'killed' });
  });
});

// Iterate the REGISTRY, not the module namespaces. `python.pinned()` rebuilds
// the runner as an explicit allow-list object, so a capability added to the
// module is silently absent from `--runner pytest` and `--runner unittest`
// unless it is listed there too — which is exactly what happened, and what a
// test over the four modules could never have caught.
describe('fatalEdit — every runner in the registry can say what "cannot compile" means', () => {
  for (const [key, r] of Object.entries(RUNNERS)) {
    it(`${key} supplies content that does not parse`, () => {
      expect(r.fatalEdit, `${key} has no fatalEdit, so a survivor under it is never checked`).toBeTypeOf('function');
      const content = r.fatalEdit();
      expect(typeof content).toBe('string');
      const dir = mkdtempSync(join(tmpdir(), 'tg-fatal-'));
      if (['python', 'pytest', 'unittest'].includes(key)) {
        const f = join(dir, 'x.py');
        writeFileSync(f, content);
        // Compile rather than import: it must fail before any side effect.
        const out = spawnSync('python3', ['-c', `import py_compile,sys\ntry:\n py_compile.compile(${JSON.stringify(f)}, doraise=True)\n sys.exit(0)\nexcept Exception:\n sys.exit(1)`], { encoding: 'utf8' });
        if (out.error) return; // no python3 on this machine; the JS runners still prove the shape
        expect(out.status).toBe(1);
      } else {
        const f = join(dir, 'x.mjs');
        writeFileSync(f, content);
        expect(spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }).status).not.toBe(0);
      }
      rmSync(dir, { recursive: true, force: true });
    });
  }
});

/**
 * A repository where the declared defender never imports the subject. It
 * passes, so the fault "survives" — and that survival is a statement about the
 * defender's reach, not about its assertions. This is the shape that made the
 * Python strict-editable install report `4 passed` on a fault verified to fail
 * 2 of 4 tests, reduced to the smallest thing that reproduces it.
 */
function unreachableSubjectRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-nc-'));
  const g = (...a) => spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = () => 1;\n');
  writeFileSync(join(dir, 'src', 'b.mjs'), 'export const b = () => 2;\n');
  // Declared as a.mjs's defender, and never imports it.
  writeFileSync(join(dir, 'test', 'a.test.mjs'), "import { expect, it } from 'vitest';\nimport { b } from '../src/b.mjs';\nit('is two', () => expect(b()).toBe(2));\n");
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  g('add', '-A');
  g('commit', '-qm', 'one');
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const claims = {
    schemaVersion: 1,
    claims: [{
      id: 'C-1', statement: 'a() returns one.', severity: 'low', source: { kind: 'manual' },
      producedBy: { producer: 'human' }, defendedBy: ['test/a.test.mjs'],
      faults: [{ id: 'F1', description: 'd', faultClass: 'other', file: 'src/a.mjs', find: '1', replace: '2', producedBy: { producer: 'human' } }],
    }],
  };
  return { dir, claims };
}

describe('a fault that never runs is reported as unverifiable, not as a survivor', () => {
  it('downgrades the verdict, records the control, warns, and leaves the source byte-identical', async () => {
    const { dir, claims } = unreachableSubjectRepo();
    const before = readFileSync(join(dir, 'src', 'a.mjs'), 'utf8');
    const warnings = [];
    try {
      const ev = await probe({ projectDir: dir, claims, mode: 'in-place', confirmRuns: 1, budgetMs: 60_000, escalate: false, toolVersion: 't', onWarn: (m) => warnings.push(m) });

      expect(ev.records).toHaveLength(1);
      expect(ev.records[0]).toMatchObject({
        verdict: 'unverifiable',
        detail: { reason: 'subject-not-executed', negativeControl: 'not-reached' },
      });
      expect(warnings.some((w) => /never execute it/.test(w))).toBe(true);
      expect(validate('evidence', ev)).toMatchObject({ ok: true, errors: [] });
      // The control replaces the whole file; a probe that does not put it back
      // has destroyed the thing it was asked to measure.
      expect(readFileSync(join(dir, 'src', 'a.mjs'), 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  // The control edit is only observable in one window: escalation runs after it
  // and before the fault's own restore. Asserting "the file is byte-identical
  // afterwards" does NOT cover this — the fault's restore captured the true
  // original and puts it back regardless, so that assertion passes even with
  // the control's restore deleted. What actually breaks is every later
  // measurement in the run: escalation against a file that cannot compile fails
  // the whole suite, and every test in it is then named an undeclared killer.
  it('restores before escalation, so the wider suite is not measured against unparseable source', async () => {
    const { dir, claims } = unreachableSubjectRepo();
    // The defender imports the subject and asserts something the fault leaves
    // alone: a genuine survivor, so escalation runs.
    writeFileSync(join(dir, 'test', 'a.test.mjs'), "import { expect, it } from 'vitest';\nimport { a } from '../src/a.mjs';\nit('returns a number', () => expect(typeof a()).toBe('number'));\n");
    // A non-defender that also imports the subject. It passes on healthy
    // source and cannot survive the control's edit, so if the control is not
    // restored it fails every escalation run and is reported as an undeclared
    // killer — a finding invented entirely by the probe's own leftovers.
    writeFileSync(join(dir, 'test', 'c.test.mjs'), "import { expect, it } from 'vitest';\nimport { a } from '../src/a.mjs';\nit('is defined', () => expect(a).toBeTypeOf('function'));\n");
    spawnSync('git', ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t', 'add', '-A'], { cwd: dir });
    spawnSync('git', ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t', 'commit', '-qm', 'three'], { cwd: dir });
    try {
      const ev = await probe({ projectDir: dir, claims, mode: 'in-place', confirmRuns: 1, budgetMs: 90_000, escalate: true, toolVersion: 't' });
      const r = ev.records[0];
      expect(r.detail.negativeControl).toBe('reached');
      expect(r.verdict).toBe('survived');
      // The assertion that actually depends on the control being restored.
      // Escalation is the one window between the control's edit and the
      // fault's own restore, and the verdict does NOT move when it is
      // corrupted: an unparseable subject makes the suite fail to LOAD, and a
      // load failure names no undeclared killers by rule 3 — so the tool's own
      // pessimism hides the damage. What it cannot hide is that the wider suite
      // was never run: `error` with zero tests, instead of `pass` with two.
      expect(r.detail.escalated).toBe(true);
      expect(r.detail.escalationRuns.length).toBeGreaterThan(0);
      for (const run of r.detail.escalationRuns) {
        expect(run.outcome).toBe('pass');
        expect(run.tests.total).toBe(2);
      }
      expect(r.detail.undeclaredKillers).toBeUndefined();
      expect(validate('evidence', ev)).toMatchObject({ ok: true, errors: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('a defender that DOES import the subject keeps its survived verdict, with the control recorded', async () => {
    const { dir, claims } = unreachableSubjectRepo();
    // Same repo, but now the defender imports the subject and asserts something
    // the fault does not change — a genuine blind spot rather than an absent one.
    writeFileSync(join(dir, 'test', 'a.test.mjs'), "import { expect, it } from 'vitest';\nimport { a } from '../src/a.mjs';\nit('returns a number', () => expect(typeof a()).toBe('number'));\n");
    spawnSync('git', ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t', 'commit', '-qam', 'two'], { cwd: dir });
    try {
      const ev = await probe({ projectDir: dir, claims, mode: 'in-place', confirmRuns: 1, budgetMs: 60_000, escalate: false, toolVersion: 't' });
      expect(ev.records[0]).toMatchObject({ verdict: 'survived', detail: { negativeControl: 'reached' } });
      expect(validate('evidence', ev)).toMatchObject({ ok: true, errors: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
