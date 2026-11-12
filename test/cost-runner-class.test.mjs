// Defect F of the 0.22.1 verification: the reference workload read 177 ms on an
// 18-core laptop, inside the CI range (166 to 238 ms), while that laptop runs
// the real probe far faster than CI does. The reference tracks probe speed
// within one class of machine, not across classes. The limitation is recorded
// with the baseline and enforced: a measurement from another CPU count or
// platform than the baseline's is refused, by name, never normalized.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { assessReference, checkCostBudget, renderCostBudget, referenceFrom } from '../src/probe/cost.mjs';

const CI = { cpus: 4, platform: 'linux' };
const LAPTOP = { cpus: 18, platform: 'darwin' };
const ref = (runner) => ({ beforeMs: 177, afterMs: 177, baselineMs: 200, runner });
const report = { totalMs: 1_000_000, claims: [], reusedRecords: 0 };
const CEILING = { budgetSeconds: 3600 };

describe('the reference is only valid on the runner class its baseline was taken on', () => {
  it('accepts a measurement taken on the baseline\'s class', () => {
    const a = assessReference(ref({ baseline: CI, before: CI, after: CI }));
    expect(a.status).toBe('ok');
  });

  it('refuses a different CPU count, naming both', () => {
    const d = checkCostBudget(report, { ...CEILING, reference: ref({ baseline: CI, before: LAPTOP, after: LAPTOP }) });
    expect(d.ok).toBe(false);
    expect(d.failures).toEqual(['reference-runner-mismatch']);
    expect(d.reference.status).toBe('runner-mismatch');
    expect(d.reference.mismatch.join(' ')).toMatch(/18 CPUs/);
    expect(d.reference.mismatch.join(' ')).toMatch(/4 CPUs/);
  });

  it('refuses a different platform with the CPU count equal', () => {
    const d = checkCostBudget(report, { ...CEILING, reference: ref({ baseline: CI, before: { cpus: 4, platform: 'darwin' }, after: { cpus: 4, platform: 'darwin' } }) });
    expect(d.failures).toEqual(['reference-runner-mismatch']);
    expect(d.reference.mismatch.join(' ')).toMatch(/darwin/);
  });

  it('refuses when only one of the two measurements is from the wrong class', () => {
    const a = assessReference(ref({ baseline: CI, before: CI, after: LAPTOP }));
    expect(a.status).toBe('runner-mismatch');
  });

  it('refuses when the measurement does not say what it ran on, and when the baseline does not say what it was taken on', () => {
    expect(assessReference(ref({ baseline: CI, before: {}, after: CI })).status).toBe('runner-mismatch');
    expect(assessReference(ref({ baseline: {}, before: CI, after: CI })).status).toBe('runner-mismatch');
    expect(assessReference(ref(undefined)).status).toBe('runner-mismatch');
  });

  it('names the reason in the output, and never falls back to raw seconds', () => {
    const text = renderCostBudget(checkCostBudget(report, { ...CEILING, reference: ref({ baseline: CI, before: LAPTOP, after: LAPTOP }) }));
    expect(text).toMatch(/^COST REFERENCE RUNNER MISMATCH/);
    expect(text).toMatch(/baseline was taken on 4 CPUs \(linux\)/);
    expect(text).toMatch(/measured on 18 CPUs \(darwin\)/);
    expect(text).toMatch(/Not falling back to raw seconds/);
  });

  it('a missing measurement is still reported as missing, before the class is looked at', () => {
    expect(assessReference({ beforeMs: undefined, afterMs: 177, baselineMs: 200, runner: { baseline: CI, before: CI, after: CI } }).status).toBe('missing');
  });

  it('builds the class from the two measurements and the budget file', () => {
    const budget = { workload: 'w', baselineMs: 200, cpus: 4, platform: 'linux' };
    const m = (cpus, platform) => ({ workload: 'w', medianMs: 200, cpus, platform });
    expect(referenceFrom({ before: m(4, 'linux'), after: m(18, 'darwin'), budget }).runner).toEqual({ baseline: CI, before: CI, after: LAPTOP });
    expect(assessReference(referenceFrom({ before: m(4, 'linux'), after: m(4, 'linux'), budget })).status).toBe('ok');
    expect(assessReference(referenceFrom({ before: m(4, 'linux'), after: m(18, 'darwin'), budget })).status).toBe('runner-mismatch');
  });

  it('the committed budget file records the class its baseline was taken on', () => {
    const { reference } = JSON.parse(readFileSync(new URL('../testguard.cost-budget.json', import.meta.url), 'utf8'));
    expect(Number.isInteger(reference.cpus) && reference.cpus > 0).toBe(true);
    expect(typeof reference.platform).toBe('string');
    expect(reference.platform.length).toBeGreaterThan(0);
  });
});
