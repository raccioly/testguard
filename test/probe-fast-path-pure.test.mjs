// The two decisions the fast path makes in the command (issue #270), as pure
// functions: where a probe may carry verdicts from, and what --changed auto
// does with the base it found. Cheap on purpose: these defend self-probe claims.
import { describe, it, expect } from 'vitest';
import { autoChangedDecision, reuseSources } from '../src/commands/probe.mjs';
import { priorRecords } from '../src/probe/probe.mjs';

describe('reuseSources', () => {
  it('a partial run reads its own file and the last full probe; a full run reads its own', () => {
    expect(reuseSources({ outPath: 'p.json', canonical: 'e.json', partial: true })).toEqual(['p.json', 'e.json']);
    expect(reuseSources({ outPath: 'e.json', canonical: 'e.json', partial: false })).toEqual(['e.json']);
    expect(reuseSources({ outPath: 'e.json', canonical: 'e.json', partial: true })).toEqual(['e.json']);
    expect(reuseSources({ outPath: 'p.json', canonical: 'e.json', partial: true, noReuse: true })).toEqual([]);
  });
});

describe('priorRecords', () => {
  const instrument = { toolVersion: '1.0.0', digest: 'd' };
  const runner = { name: 'vitest', version: '5', source: 'project' };
  const policy = { confirmRuns: 3, workers: 1, serial: true, runner, instrument };
  const doc = (id, finishedAt, records, extra = {}) => ({ tool: { version: '1.0.0' }, run: { id, finishedAt, confirmRuns: 3, workers: 1, serial: true, runner, instrument, ...extra }, records });
  const rec = (claim, verdict) => ({ claim: { id: claim }, subject: { id: 'F1' }, verdict });

  it('keys every reusable record by claim/fault with the run it came from; the later document wins', () => {
    const older = doc('run-1', '2026-01-01T00:00:00Z', [rec('A', 'killed'), rec('B', 'survived')]);
    const newer = doc('run-2', '2026-01-02T00:00:00Z', [rec('B', 'killed')]);
    const map = priorRecords([newer, older], policy);
    expect(map.get('A/F1')).toEqual({ record: rec('A', 'killed'), runId: 'run-1' });
    expect(map.get('B/F1')).toEqual({ record: rec('B', 'killed'), runId: 'run-2' });
  });

  it('a document that fails the reuse rules contributes nothing, and one document still works', () => {
    const other = doc('run-3', '2026-01-03T00:00:00Z', [rec('A', 'killed')], { confirmRuns: 1 });
    expect(priorRecords([other], policy).size).toBe(0);
    expect(priorRecords(doc('run-1', 'x', [rec('A', 'killed')]), policy).get('A/F1').runId).toBe('run-1');
    expect(priorRecords(undefined, policy).size).toBe(0);
  });
});

describe('autoChangedDecision', () => {
  const detected = { ref: 'origin/main', from: 'GITHUB_BASE_REF' };
  it('a base that resolves narrows the probe', () => {
    expect(autoChangedDecision(detected, true)).toEqual({ changed: 'origin/main', message: '--changed auto: comparing against origin/main (GITHUB_BASE_REF)', warn: false });
  });

  it('a base that does not resolve here, or none, is a full probe that says so — never a skip', () => {
    const shallow = autoChangedDecision(detected, false);
    expect(shallow.changed).toBeUndefined();
    expect(shallow.warn).toBe(true);
    expect(shallow.message).toMatch(/does not resolve here, so every claim is probed; fetch it/);
    const none = autoChangedDecision(null, false);
    expect(none).toEqual({ changed: undefined, message: expect.stringMatching(/no base to compare against .* so every claim is probed/), warn: true });
  });
});
