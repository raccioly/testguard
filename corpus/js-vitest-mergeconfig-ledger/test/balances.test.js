import { describe, it, expect } from 'vitest';
import { createLedger } from '../src/ledger.js';

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

describe('R5 net balances', () => {
  it('subtracts the payer\'s own portion when the payer is also a participant', () => {
    const ledger = createLedger();
    ledger.record({ payer: 'Ana', amount: 300, participants: ['Ana', 'Bo', 'Cy'], split: 'equal' });
    expect(ledger.balances()).toEqual({ Ana: 200, Bo: -100, Cy: -100 });
  });

  it('credits the full amount to a payer who is not a participant', () => {
    const ledger = createLedger();
    ledger.record({ payer: 'Dee', amount: 100, participants: ['Ana', 'Bo'], split: 'equal' });
    expect(ledger.balances()).toEqual({ Dee: 100, Ana: -50, Bo: -50 });
  });

  it('includes a payer who is not a participant even though they owe nothing', () => {
    const ledger = createLedger();
    ledger.record({ payer: 'Dee', amount: 100, participants: ['Ana'], split: 'equal' });
    expect(Object.keys(ledger.balances()).sort()).toEqual(['Ana', 'Dee']);
  });

  it('uses the split remainder rules when computing portions', () => {
    const ledger = createLedger();
    ledger.record({ payer: 'Ana', amount: 100, participants: ['Ana', 'Bo', 'Cy'], split: 'equal' });
    // Ana paid 100 and owes 34; Bo and Cy owe 33 each
    expect(ledger.balances()).toEqual({ Ana: 66, Bo: -33, Cy: -33 });
  });

  it('works with shares splits', () => {
    const ledger = createLedger();
    ledger.record({ payer: 'Ana', amount: 100, participants: ['Ana', 'Bo'], split: 'shares', shares: { Ana: 1, Bo: 2 } });
    expect(ledger.balances()).toEqual({ Ana: 67, Bo: -67 });
  });

  it('accumulates across several expenses', () => {
    const ledger = createLedger();
    ledger.record({ payer: 'Ana', amount: 100, participants: ['Ana', 'Bo', 'Cy'], split: 'equal' });
    ledger.record({ payer: 'Bo', amount: 60, participants: ['Ana', 'Bo'], split: 'equal' });
    expect(ledger.balances()).toEqual({ Ana: 36, Bo: -3, Cy: -33 });
  });

  it('reports a positive balance to someone owed and a negative one to someone who owes', () => {
    const ledger = createLedger();
    ledger.record({ payer: 'Ana', amount: 50, participants: ['Bo'], split: 'equal' });
    const b = ledger.balances();
    expect(b.Ana).toBeGreaterThan(0);
    expect(b.Bo).toBeLessThan(0);
  });

  it('shows exactly zero for someone who paid exactly their share', () => {
    const ledger = createLedger();
    ledger.record({ payer: 'Ana', amount: 100, participants: ['Bo'], split: 'equal' });
    ledger.record({ payer: 'Bo', amount: 100, participants: ['Ana'], split: 'equal' });
    const b = ledger.balances();
    expect(b).toEqual({ Ana: 0, Bo: 0 });
    expect(Object.is(b.Ana, 0)).toBe(true);
    expect(Object.is(b.Bo, 0)).toBe(true);
  });

  it('omits roommates who appear in no expense', () => {
    const ledger = createLedger();
    ledger.record({ payer: 'Ana', amount: 100, participants: ['Ana', 'Bo'], split: 'equal' });
    expect(ledger.balances()).not.toHaveProperty('Cy');
    expect(Object.keys(ledger.balances())).toHaveLength(2);
  });

  it('treats names case-sensitively', () => {
    const ledger = createLedger();
    ledger.record({ payer: 'ana', amount: 100, participants: ['Ana'], split: 'equal' });
    expect(ledger.balances()).toEqual({ ana: 100, Ana: -100 });
  });

  it('sums to exactly zero across all roommates', () => {
    const ledger = createLedger();
    ledger.record({ payer: 'Ana', amount: 100, participants: ['Ana', 'Bo', 'Cy'], split: 'equal' });
    ledger.record({ payer: 'Dee', amount: 1, participants: ['Ana', 'Bo', 'Cy'], split: 'equal' });
    ledger.record({ payer: 'Bo', amount: 99, participants: ['Ana', 'Cy'], split: 'shares', shares: { Ana: 3, Cy: 7 } });
    ledger.record({ payer: 'Cy', amount: 12345, participants: ['Ana', 'Bo', 'Cy', 'Dee'], split: 'equal' });
    expect(sum(ledger.balances())).toBe(0);
  });

  it('sums to zero for a single expense with an odd amount', () => {
    const ledger = createLedger();
    ledger.record({ payer: 'Ana', amount: 7, participants: ['Bo', 'Cy', 'Dee'], split: 'equal' });
    expect(sum(ledger.balances())).toBe(0);
  });

  it('returns whole-cent integers', () => {
    const ledger = createLedger();
    ledger.record({ payer: 'Ana', amount: 100, participants: ['Ana', 'Bo', 'Cy'], split: 'shares', shares: { Ana: 1, Bo: 1, Cy: 1 } });
    for (const v of Object.values(ledger.balances())) expect(Number.isInteger(v)).toBe(true);
  });

  it('does not change when balances() is called repeatedly', () => {
    const ledger = createLedger();
    ledger.record({ payer: 'Ana', amount: 100, participants: ['Ana', 'Bo'], split: 'equal' });
    expect(ledger.balances()).toEqual(ledger.balances());
  });

  it('keeps separate ledgers independent', () => {
    const a = createLedger();
    const b = createLedger();
    a.record({ payer: 'Ana', amount: 100, participants: ['Bo'], split: 'equal' });
    expect(b.balances()).toEqual({});
  });
});

describe('R6 order independence and empty ledger', () => {
  const expenses = [
    { payer: 'Ana', amount: 100, participants: ['Ana', 'Bo', 'Cy'], split: 'equal' },
    { payer: 'Bo', amount: 60, participants: ['Ana', 'Bo'], split: 'equal' },
    { payer: 'Cy', amount: 99, participants: ['Ana', 'Cy'], split: 'shares', shares: { Ana: 3, Cy: 7 } },
    { payer: 'Dee', amount: 7, participants: ['Bo', 'Cy', 'Dee'], split: 'equal' },
  ];

  const build = (list) => {
    const ledger = createLedger();
    for (const e of list) ledger.record(e);
    return ledger.balances();
  };

  it('gives the same balances for any recording order', () => {
    const forward = build(expenses);
    expect(build([...expenses].reverse())).toEqual(forward);
    expect(build([expenses[2], expenses[0], expenses[3], expenses[1]])).toEqual(forward);
    expect(build([expenses[1], expenses[3], expenses[0], expenses[2]])).toEqual(forward);
  });

  it('lists names in the same order regardless of recording order', () => {
    expect(Object.keys(build([...expenses].reverse()))).toEqual(Object.keys(build(expenses)));
  });

  it('gives the same balances when participants are listed in a different order', () => {
    const one = createLedger();
    one.record({ payer: 'Ana', amount: 101, participants: ['Ana', 'Bo', 'Cy'], split: 'equal' });
    const two = createLedger();
    two.record({ payer: 'Ana', amount: 101, participants: ['Cy', 'Bo', 'Ana'], split: 'equal' });
    expect(two.balances()).toEqual(one.balances());
  });

  it('returns an empty result for a ledger with no expenses', () => {
    expect(createLedger().balances()).toEqual({});
  });

  it('does not throw for an empty ledger', () => {
    expect(() => createLedger().balances()).not.toThrow();
  });
});
