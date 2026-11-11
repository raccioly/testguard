// @req FR-03
// Issue #236: the pure parts. classify takes the type check as an input, the
// type check is an input to reuse, and the first diagnostic is read from tsc output.
import { describe, expect, it } from 'vitest';
import { firstDiagnostic, sameTypecheck } from '../src/probe/typecheck.mjs';
import { classify } from '../src/probe/classify.mjs';
import { reusableRun } from '../src/probe/probe.mjs';

describe('firstDiagnostic and sameTypecheck', () => {
  it('takes the first error TS line, global ones included, and nothing from noise', () => {
    expect(firstDiagnostic("a\nsrc/x.ts(1,2): error TS1005: ';' expected.\nsrc/y.ts(3,4): error TS2322: no")).toBe("src/x.ts(1,2): error TS1005: ';' expected.");
    expect(firstDiagnostic('error TS5083: Cannot read file')).toBe('error TS5083: Cannot read file');
    expect(firstDiagnostic('Found 0 errors.')).toBeUndefined();
  });
  it('is the same instrument only for the same command and the same checker', () => {
    const t = { commandHash: 'a'.repeat(64), version: '5.9.3' };
    expect(sameTypecheck(undefined, undefined)).toBe(true);
    expect(sameTypecheck(t, { ...t })).toBe(true);
    expect(sameTypecheck(undefined, t)).toBe(false);
    expect(sameTypecheck(t, undefined)).toBe(false);
    expect(sameTypecheck(t, { ...t, version: '5.9.4' })).toBe(false);
    expect(sameTypecheck(t, { ...t, commandHash: 'b'.repeat(64) })).toBe(false);
  });
});

describe('classify takes the type check as an input', () => {
  const pass = { outcome: 'pass', assertionFailures: 0, timeouts: 0 };
  const ok = { status: 'ok' };
  const base = { defenders: ['t.test.ts'], anchor: ok, baselineRuns: [pass, pass, pass], probeRuns: [], confirmRuns: 3 };

  it('diagnostics are fault-invalid before any test ran, even over a red baseline', () => {
    const want = { verdict: 'fault-invalid', reason: 'replacement-does-not-typecheck' };
    expect(classify({ ...base, typecheck: { status: 'diagnostics', message: 'x' } })).toEqual(want);
    expect(classify({ ...base, baselineRuns: [], typecheck: { status: 'diagnostics' } })).toEqual(want);
  });
  it('a type check that timed out is a timeout', () => {
    expect(classify({ ...base, typecheck: { status: 'timeout' } })).toEqual({ verdict: 'timeout', reason: 'typecheck-timed-out' });
  });
  it('nocover and an anchor that does not hit still come first: there is no fault to check', () => {
    expect(classify({ ...base, defenders: [], typecheck: { status: 'diagnostics' } })).toEqual({ verdict: 'nocover' });
    expect(classify({ ...base, anchor: { status: 'anchor-missing' }, typecheck: { status: 'diagnostics' } })).toEqual({ verdict: 'unverifiable', reason: 'anchor-missing' });
  });
  it('clean, not-applicable and absent change nothing', () => {
    const kill = { outcome: 'fail', assertionFailures: 1, timeouts: 0 };
    const probeRuns = [kill, kill, kill];
    const plain = classify({ ...base, probeRuns });
    for (const typecheck of [undefined, { status: 'clean' }, { status: 'not-applicable' }]) expect(classify({ ...base, probeRuns, typecheck })).toEqual(plain);
    expect(plain.verdict).toBe('killed');
  });
});

describe('the type check is an input to reuse', () => {
  const runner = { name: 'vitest', version: '5.0.5', source: 'project' };
  const instrument = { toolVersion: '1.0.0', digest: 'd'.repeat(64) };
  const typecheck = { commandHash: 'c'.repeat(64), version: '5.9.3' };
  const previous = (extra = {}) => ({ tool: { version: '1.0.0' }, run: { confirmRuns: 3, workers: 1, serial: true, runner, instrument, ...extra } });
  const now = { confirmRuns: 3, workers: 1, serial: true, runner, instrument };

  it('without on both sides, and with the same on both, is reusable', () => {
    expect(reusableRun(previous(), now)).toBe(true);
    expect(reusableRun(previous({ typecheck }), { ...now, typecheck })).toBe(true);
  });
  it('measured without it is not reusable by a run with it, and the reverse', () => {
    expect(reusableRun(previous(), { ...now, typecheck })).toBe(false);
    expect(reusableRun(previous({ typecheck }), now)).toBe(false);
  });
  it('another command or another checker version is another instrument', () => {
    expect(reusableRun(previous({ typecheck }), { ...now, typecheck: { ...typecheck, version: '5.9.4' } })).toBe(false);
    expect(reusableRun(previous({ typecheck }), { ...now, typecheck: { ...typecheck, commandHash: 'e'.repeat(64) } })).toBe(false);
  });
});
