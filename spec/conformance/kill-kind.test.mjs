// A kill is made by an assertion, by an exception only, or by both; the
// record says which, derived from its own probe runs, and a policy result is
// a pure function of the records it ran on.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validate } from '../lib/validate.mjs';
const example = (name) => JSON.parse(readFileSync(new URL(`./examples/${name}.json`, import.meta.url), 'utf8'));

describe('kill kinds — evidence', () => {
  it('evidence written before exceptionFailures and killKind existed still conforms', () => {
    expect(validate('evidence', example('evidence')).errors).toEqual([]);
  });
  it('a kill by exceptions alone conforms: the default verdict is unchanged', () => {
    const doc = example('evidence-kill-kinds');
    expect(doc.records.map((r) => [r.verdict, r.detail.killKind])).toEqual([['killed', 'assertion'], ['killed', 'exception-only'], ['killed', 'mixed']]);
    expect(validate('evidence', doc).errors).toEqual([]);
  });
  it('a killed record whose runs have no failing test body at all is refused', () => {
    const doc = example('evidence-kill-kinds');
    doc.records[0].detail.probeRuns[0].assertionFailures = 0;
    doc.records[0].detail.probeRuns[0].exceptionFailures = 0;
    delete doc.records[0].detail.killKind;
    expect(validate('evidence', doc).errors.map((e) => e.message).join('\n')).toMatch(/at least one failing test body/);
  });
  it('killKind is checked against the runs, not trusted', () => {
    const doc = example('evidence-kill-kinds');
    doc.records[2].detail.killKind = 'assertion';
    expect(validate('evidence', doc).errors.map((e) => e.message).join('\n')).toMatch(/killKind assertion contradicts the probe runs, which say mixed/);
  });
  it('an unknown killKind is refused by the schema', () => {
    const doc = example('evidence-kill-kinds');
    doc.records[0].detail.killKind = 'crash';
    expect(validate('evidence', doc).ok).toBe(false);
  });
  it('a policy result is optional, and a legacy kill with no kind must be listed as unproven', () => {
    const doc = example('evidence-kill-kinds');
    delete doc.assertionPolicy;
    expect(validate('evidence', doc).errors).toEqual([]);
    delete doc.records[0].detail.killKind;
    doc.assertionPolicy = { state: 'failed', exceptionOnlyKills: [{ claimId: doc.records[0].claim.id, faultId: 'F4' }] };
    expect(validate('evidence', doc).ok).toBe(false);
    doc.assertionPolicy.exceptionOnlyKills.push({ claimId: doc.records[0].claim.id, faultId: 'F2' });
    expect(validate('evidence', doc).errors).toEqual([]);
  });
});

describe('kill kinds — exception-only because the runner reported nothing', () => {
  const unreported = () => {
    const doc = example('evidence-kill-kinds');
    const r = doc.records[1];
    r.detail.probeRuns.forEach((x) => { x.kindNotReported = x.exceptionFailures; });
    r.detail.killKindReason = 'kind-not-reported-by-runner';
    doc.assertionPolicy.exceptionOnlyKills[0].reason = 'kind-not-reported-by-runner';
    return doc;
  };
  it('conforms when every exception failure was unreported, and the policy entry repeats the reason', () => {
    expect(validate('evidence', unreported()).errors).toEqual([]);
  });
  it('is refused when some exception failure was a reported one', () => {
    const doc = unreported();
    doc.records[1].detail.probeRuns[0].kindNotReported = 0;
    expect(validate('evidence', doc).errors.map((e) => e.message).join('\n')).toMatch(/killKindReason is only valid/);
  });
  it('is refused on an assertion kill', () => {
    const doc = unreported();
    doc.records[0].detail.killKindReason = 'kind-not-reported-by-runner';
    expect(validate('evidence', doc).ok).toBe(false);
  });
  it('the policy entry must carry exactly its record\'s reason', () => {
    const doc = unreported();
    delete doc.assertionPolicy.exceptionOnlyKills[0].reason;
    expect(validate('evidence', doc).errors.map((e) => e.message).join('\n')).toMatch(/exactly the killKindReason/);
    const other = unreported(); other.assertionPolicy.exceptionOnlyKills[0].reason = 'because';
    expect(validate('evidence', other).ok).toBe(false);
  });
});

describe('kill kinds — status', () => {
  const status = () => {
    const doc = example('status');
    doc.run = { id: 'run-1', evidence: '.testguard/evidence.json', provisional: false, records: 1, newSinceBaseline: 0, exitCode: 1, assertionPolicy: { state: 'failed', exceptionOnlyKills: [{ claimId: 'A', faultId: 'F1' }] } };
    return doc;
  };
  it('a failed assertion policy conforms with exit 1', () => expect(validate('status', status()).errors).toEqual([]));
  it('a failed assertion policy cannot exit 0', () => {
    const doc = status(); doc.run.exitCode = 0;
    expect(validate('status', doc).errors.map((e) => e.message).join('\n')).toMatch(/failed assertion policy cannot exit 0/);
  });
  it('state must agree with the list', () => {
    const doc = status(); doc.run.assertionPolicy.state = 'passed';
    expect(validate('status', doc).ok).toBe(false);
  });
  it('counts.killedExceptionOnly is an optional non-negative integer', () => {
    const doc = example('status'); doc.counts.killedExceptionOnly = 2;
    expect(validate('status', doc).errors).toEqual([]);
    doc.counts.killedExceptionOnly = -1;
    expect(validate('status', doc).ok).toBe(false);
  });
});
