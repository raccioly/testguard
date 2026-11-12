import { describe, expect, it } from 'vitest';
import { decideAdmission } from '../src/admit/admit.mjs';

const record = (id, verdict) => ({ subject: { id }, verdict, detail: {} });

describe('admission decision', () => {
  it('requires every probed fault to be killed', () => {
    const decision = decideAdmission([
      record('F1', 'survived'),
      record('F2', 'killed'),
    ]);

    expect(decision).toMatchObject({
      admitted: false,
      blocking: { subject: { id: 'F1' }, verdict: 'survived' },
    });
  });
});

// The decision's rules, kept here (and not in the end-to-end admit acceptance file) so the claim that defends them stays a fraction of a second.
const rec = (id, verdict, reason) => ({ subject: { id }, verdict, detail: reason ? { reason } : {} });

describe('decideAdmission (pure)', () => {
  it('admits only when every fault is killed', () => {
    expect(decideAdmission([rec('F1', 'killed'), rec('F2', 'killed')])).toEqual({ admitted: true, blocking: null });
    // one kill is not enough — the whole point of the two gates
    expect(decideAdmission([rec('F1', 'survived'), rec('F2', 'killed')]).admitted).toBe(false);
    expect(decideAdmission([rec('F1', 'killed'), rec('F2', 'survived')]).admitted).toBe(false);
  });
  it('names the first blocking fault in gate order: survived before flaky-defender', () => {
    const d = decideAdmission([rec('F1', 'flaky-defender', 'defenders-not-green'), rec('F2', 'killed'), rec('F3', 'survived')]);
    expect(d.admitted).toBe(false);
    expect(d.blocking.subject.id).toBe('F3');
  });
  it('never admits an empty record set', () => {
    expect(decideAdmission([])).toEqual({ admitted: false, blocking: null });
  });
});
