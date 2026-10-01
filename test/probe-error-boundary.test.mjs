// @req FR-02
// @req NFR-03
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { PreconditionError } from '../src/probe/worktree.mjs';
import { validate } from '../spec/lib/validate.mjs';



// The safety net is for an *unexpected* throw from inside one fault's body —
// by definition not something an input can provoke on demand. So provoke it
// where it really happened: at the moment the fault is applied, which in #64
// was a parallel session deleting the scratch worktree mid-run.
const boom = vi.hoisted(() => ({ faultId: null, error: null }));
vi.mock('../src/probe/inject.mjs', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    applyFault: (dir, fault, opts) => {
      if (fault.id === boom.faultId) throw boom.error ?? new TypeError(`simulated failure applying ${fault.id}\n    at applyFault (inject.mjs:81:5)`);
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
  const g = (...a) => spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8', timeout: 5000 });
  g('init', '-q');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  for (const n of ['a', 'b']) {
    writeFileSync(join(dir, 'src', `${n}.mjs`), `export const ${n} = () => 1;\n`);
    writeFileSync(join(dir, 'test', `${n}.test.mjs`), `import { expect, it } from 'vitest';\nimport { ${n} } from '../src/${n}.mjs';\nit('is one', () => expect(${n}()).toBe(1));\n`);
  }
  // Control runner observations so these tests isolate the real per-fault
  // catch boundary. The original native Vitest integration is retained.
  writeFileSync(join(dir, 'runner.cjs'), `const fs=require('node:fs');const file=process.argv[2];const target=file.replace('test/','src/').replace('.test.mjs','.mjs');const pass=fs.readFileSync(target,'utf8').includes('() => 1');fs.writeFileSync(process.argv.at(-1),JSON.stringify({success:pass,numTotalTests:1,numPassedTests:Number(pass),numFailedTests:Number(!pass),testResults:[{name:file,assertionResults:[{status:pass?'passed':'failed',fullName:'is one',failureMessages:pass?[]:['AssertionError: expected one']}]}]}));`);
  g('add', '-A');
  g('commit', '-qm', 'one');
  const claims = {
    schemaVersion: 1,
    claims: [
      { ...CLAIM, faults: [FAULT] },
      { ...CLAIM, id: 'C-2', defendedBy: ['test/b.test.mjs'], faults: [{ ...FAULT, id: 'F2', file: 'src/b.mjs' }] },
    ],
  };
  return { dir, claims };
}

describe('one bad fault does not cost the evidence for the rest', () => {
  it('records the fault that threw as unverifiable and still returns a complete, conformant document', async () => {
    const { dir, claims } = repo();
    const warnings = [];
    boom.faultId = 'F2';
    try {
      const ev = await probe({ projectDir: dir, claims, mode: 'in-place', runnerCommand: `${JSON.stringify(process.execPath)} runner.cjs {files} {out}`, confirmRuns: 1, budgetMs: 60_000, escalate: false, toolVersion: 't', onWarn: (m) => warnings.push(m) });

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
      boom.error = null;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('still refuses the whole run on a precondition failure, which is about every verdict in it', async () => {
    const { dir, claims } = repo();
    // Inject at applyFault so the error originates inside the exact per-fault
    // try/catch this regression defends. Runner preflights happen earlier and
    // cannot prove that this catch preserves whole-run preconditions.
    boom.faultId = 'F1';
    boom.error = new PreconditionError('simulated whole-run precondition');
    try {
      await expect(probe({ projectDir: dir, claims, mode: 'in-place', runnerCommand: `${JSON.stringify(process.execPath)} runner.cjs {files} {out}`, confirmRuns: 1, budgetMs: 30_000, escalate: false, toolVersion: 't' }))
        .rejects.toThrow(PreconditionError);
    } finally {
      boom.faultId = null;
      boom.error = null;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

