// The status machine over a selection (defect A). computeStatus without `only`
// answers for the whole claims file; with it, for the selected claims alone.
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { computeStatus } from '../src/status/status.mjs';
import { renderScopedView, scopedView } from '../src/commands/probe-scope.mjs';
import { claimsDoc, project } from './helpers/scope-project.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

/** TAX-DOUBLES has an anchor that no longer locates; PRICE-TOTAL is sound. */
const brokenOtherClaim = () => {
  const claims = claimsDoc();
  claims.claims[1].faults[1].find = 'text that is nowhere in src/tax.mjs';
  const p = project({ claims });
  roots.push(p.root);
  return p.dir;
};

describe('computeStatus over a selection', () => {
  it('the whole file is invalid-anchors; the selection that does not include the broken claim is not', () => {
    const dir = brokenOtherClaim();
    const whole = computeStatus({ projectDir: dir });
    expect(whole.state).toBe('invalid-anchors');
    expect(whole.invalidFaults.map((f) => f.claimId)).toEqual(['TAX-DOUBLES']);
    const scoped = computeStatus({ projectDir: dir, only: ['PRICE-TOTAL'] });
    expect(scoped.state).toBe('unprobed');
    expect(scoped.invalidFaults).toEqual([]);
    expect(scoped.counts.claims).toBe(1);
  });

  it('a selection that includes the broken claim is told to repair it', () => {
    const scoped = computeStatus({ projectDir: brokenOtherClaim(), only: ['TAX-DOUBLES'] });
    expect(scoped.state).toBe('invalid-anchors');
    expect(scoped.next.target.claimId).toBe('TAX-DOUBLES');
  });

  it('scopedView reduces to the two fields a caller acts on', () => {
    const view = scopedView({ probedClaims: ['PRICE-TOTAL'], projectDir: brokenOtherClaim() });
    expect(Object.keys(view).sort()).toEqual(['next', 'state']);
    expect(view.state).toBe('unprobed');
  });
});

describe('renderScopedView', () => {
  const scope = { probedCount: 2 };
  const view = { state: 'clean', next: { action: 'none', command: 'testguard probe', why: 'Every claim is defended.' } };
  const whole = (state, why) => ({ state, next: { action: 'repair-fault', command: 'testguard claims --check-anchors', why } });

  it('leads with the selection and names the rest of the file only when it differs', () => {
    const differing = renderScopedView(scope, view, whole('invalid-anchors', '1 fault anchor no longer locates exactly.'));
    expect(differing[0]).toBe('scope:    clean over 2 selected claims; next: [none] testguard probe');
    expect(differing[1]).toBe('why:      Every claim is defended.');
    expect(differing[2]).toMatch(/^rest of the file: invalid-anchors; next: \[repair-fault\] testguard claims --check-anchors/);
    const same = renderScopedView({ probedCount: 1 }, view, { state: 'clean', next: view.next });
    expect(same).toHaveLength(2);
    expect(same[0]).toMatch(/over 1 selected claim;/);
  });
});
