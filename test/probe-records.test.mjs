// @req FR-02
// @req NFR-03
import { describe, it, expect } from 'vitest';
import { errorRecord, discoveryIndeterminateRecord, checkProvenance } from '../src/probe/probe.mjs';
import { PreconditionError } from '../src/probe/worktree.mjs';
import { validate } from '../spec/lib/validate.mjs';

const CLAIM = {
  id: 'C-1',
  statement: 'a() returns one.',
  severity: 'low',
  source: { kind: 'manual' },
  producedBy: { producer: 'human' },
  defendedBy: ['test/a.test.mjs'],
};
const FAULT = { id: 'F1', description: 'd', faultClass: 'other', file: 'src/a.mjs', find: '1', replace: '2', producedBy: { producer: 'human' } };

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

describe('discoveryIndeterminateRecord', () => {
  it('fails closed without claiming nocover and conforms to the evidence schema', () => {
    const record = discoveryIndeterminateRecord({
      claim: { ...CLAIM, faults: [FAULT], defendedBy: undefined },
      fault: FAULT,
      defenders: [],
      discovered: true,
      inputs: { targetHash: 'a'.repeat(64), defenderHashes: {}, testUniverseHash: 'b'.repeat(64), discoveryHashes: { 'test/a.test.mjs': 'c'.repeat(64) } },
      indeterminate: [{ file: 'test/a.test.mjs', reason: 'ambiguous-resolution' }],
    });
    expect(record).toMatchObject({ verdict: 'unverifiable', detail: { reason: 'defender-discovery-indeterminate' }, defenders: { nocover: false, discovered: true } });
    const doc = {
      schemaVersion: 1,
      tool: { name: 'testguard', version: '0.0.0' },
      run: { id: 'run-20260918-000000', startedAt: '2026-09-18T00:00:00Z', finishedAt: '2026-09-18T00:00:01Z', repo: { head: 'a'.repeat(40), dirty: false }, runner: { name: 'vitest' }, confirmRuns: 3, mode: 'worktree' },
      records: [record],
    };
    expect(validate('evidence', doc)).toMatchObject({ ok: true, errors: [] });
  });
});

describe('checkProvenance — the fault must be the code that ran', () => {
  const claim = { id: 'C-1' };
  const fault = { id: 'F1', file: 'demo/redact.py' };
  const call = (provenance, isoReal, detail = {}) => {
    const warnings = [];
    checkProvenance({ claim, fault, provenance, isoReal, detail, onWarn: (m) => warnings.push(m) });
    return { detail, warnings };
  };

  it('refuses the whole run when the interpreter loaded the module from outside the probed tree', () => {
    // Not a verdict about one claim: every verdict in the run would be false,
    // because nothing TestGuard changed could ever have executed.
    expect(() => call({ 'demo/redact.py': '/usr/lib/python3/site-packages/demo/redact.py' }, '/scratch/probe'))
      .toThrow(PreconditionError);
    expect(() => call({ 'demo/redact.py': '/usr/lib/python3/site-packages/demo/redact.py' }, '/scratch/probe'))
      .toThrow(/imported .* instead|strict editable|--in-place/s);
  });

  it('accepts a module loaded from inside the probed tree', () => {
    const { detail, warnings } = call({ 'demo/redact.py': '/scratch/probe/demo/redact.py' }, '/scratch/probe');
    expect(detail.targetNotImported).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('records and warns, but does not refuse, when nothing imported the subject', () => {
    // A lazy import inside a branch the fault does not reach is legitimate;
    // refusing would substitute the tool's judgement for the author's.
    const { detail, warnings } = call({ 'demo/redact.py': null }, '/scratch/probe');
    expect(detail.targetNotImported).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/never imported/);
  });

  it('says nothing when the runner cannot report provenance at all', () => {
    expect(call(undefined, '/scratch/probe').detail).toEqual({});
    expect(call({}, '/scratch/probe').detail).toEqual({});
  });
});

