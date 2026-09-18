// @req FR-02
// @req NFR-03
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { probe, errorRecord } from '../src/probe/probe.mjs';
import { PreconditionError } from '../src/probe/worktree.mjs';
import { validate } from '../spec/lib/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The safety net is for an *unexpected* throw from inside one fault's body —
// by definition not something an input can provoke on demand. So provoke it
// where it really happened: at the moment the fault is applied, which in #64
// was a parallel session deleting the scratch worktree mid-run.
const boom = vi.hoisted(() => ({ faultId: null }));
vi.mock('../src/probe/inject.mjs', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    applyFault: (dir, fault, opts) => {
      if (fault.id === boom.faultId) throw new TypeError(`simulated failure applying ${fault.id}\n    at applyFault (inject.mjs:81:5)`);
      return real.applyFault(dir, fault, opts);
    },
  };
});

const CLAIM = {
  id: 'C-1',
  statement: 'a() returns one.',
  severity: 'low',
  source: { kind: 'manual' },
  producedBy: { producer: 'human' },
  defendedBy: ['test/a.test.mjs'],
};
const FAULT = { id: 'F1', description: 'd', faultClass: 'other', file: 'src/a.mjs', find: '1', replace: '2', producedBy: { producer: 'human' } };

/** A repo with two claims over two source files, each with its own defender. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-probe-error-'));
  const g = (...a) => spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  for (const n of ['a', 'b']) {
    writeFileSync(join(dir, 'src', `${n}.mjs`), `export const ${n} = () => 1;\n`);
    writeFileSync(join(dir, 'test', `${n}.test.mjs`), `import { expect, it } from 'vitest';\nimport { ${n} } from '../src/${n}.mjs';\nit('is one', () => expect(${n}()).toBe(1));\n`);
  }
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  g('add', '-A');
  g('commit', '-qm', 'one');
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const claims = {
    schemaVersion: 1,
    claims: [
      { ...CLAIM, faults: [FAULT] },
      { ...CLAIM, id: 'C-2', defendedBy: ['test/b.test.mjs'], faults: [{ ...FAULT, id: 'F2', file: 'src/b.mjs' }] },
    ],
  };
  return { dir, claims };
}

describe('errorRecord — the shape a fault gets when probing it threw', () => {
  const record = errorRecord({
    claim: { ...CLAIM, faults: [FAULT] },
    fault: FAULT,
    defenders: ['test/a.test.mjs'],
    discovered: false,
    error: new Error("ENOENT: no such file or directory, open '/tmp/testguard-hltTCx/src/a.mjs'\n    at Object.restore (inject.mjs:81:5)"),
    inputs: { targetHash: 'a'.repeat(64), defenderHashes: { 'test/a.test.mjs': 'b'.repeat(64) } },
  });

  it('is unverifiable with reason probe-error and no runs, because nothing ran', () => {
    expect(record.verdict).toBe('unverifiable');
    expect(record.detail.reason).toBe('probe-error');
    expect(record.detail.baselineRuns).toEqual([]);
    expect(record.detail.probeRuns).toEqual([]);
  });

  it('carries the first line of what threw, so the document is readable without rerunning it', () => {
    expect(record.detail.message).toMatch(/^ENOENT: no such file or directory/);
    expect(record.detail.message).not.toContain('\n'); // the stack belongs in the console, not the evidence
  });

  it('is a conformant record inside a conformant document', () => {
    const doc = {
      schemaVersion: 1,
      tool: { name: 'testguard', version: '0.0.0' },
      run: { id: 'run-20260918-000000', startedAt: '2026-09-18T00:00:00Z', finishedAt: '2026-09-18T00:00:01Z', repo: { head: 'a'.repeat(40), dirty: false }, runner: { name: 'vitest' }, confirmRuns: 3, mode: 'worktree' },
      records: [record],
    };
    expect(validate('evidence', doc)).toMatchObject({ ok: true, errors: [] });
  });
});

describe('one bad fault does not cost the evidence for the rest', () => {
  it('records the fault that threw as unverifiable and still returns a complete, conformant document', async () => {
    const { dir, claims } = repo();
    const warnings = [];
    boom.faultId = 'F2';
    try {
      const ev = await probe({ projectDir: dir, claims, mode: 'in-place', confirmRuns: 1, budgetMs: 60_000, escalate: false, toolVersion: 't', onWarn: (m) => warnings.push(m) });

      // The first claim still has a real, measured verdict. Before this, the
      // throw took the process down and the document was never written at all.
      expect(ev.records).toHaveLength(2);
      expect(ev.records[0]).toMatchObject({ claim: { id: 'C-1' }, verdict: 'killed' });
      expect(ev.records[1]).toMatchObject({ claim: { id: 'C-2' }, verdict: 'unverifiable', detail: { reason: 'probe-error' } });
      expect(ev.records[1].detail.message).toMatch(/^simulated failure applying F2$/);
      expect(warnings.some((w) => /C-2\/F2.*unverifiable/s.test(w))).toBe(true);
      expect(validate('evidence', ev)).toMatchObject({ ok: true, errors: [] });
    } finally {
      boom.faultId = null;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('still refuses the whole run on a precondition failure, which is about every verdict in it', async () => {
    const { dir, claims } = repo();
    // A Python defender with no usable interpreter: `ensureOwned` raises from
    // inside the per-fault body, which is precisely where the catch sits. A
    // catch that swallowed this would turn "no verdict in this run means
    // anything" into one quiet unverifiable claim.
    writeFileSync(join(dir, 'test', 'a_test.py'), 'def test_a():\n    assert True\n');
    claims.claims = [{ ...CLAIM, defendedBy: ['test/a_test.py'], faults: [FAULT] }];
    await expect(probe({ projectDir: dir, claims, mode: 'in-place', confirmRuns: 1, budgetMs: 30_000, escalate: false, toolVersion: 't', python: '/nonexistent/python-binary' }))
      .rejects.toThrow(PreconditionError);
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});
