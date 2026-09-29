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
