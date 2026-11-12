import { describe, it, expect } from 'vitest';
import { createLedger } from '../src/ledger.js';
import { InvalidAmount, InvalidSplit, UnknownSplitType } from '../src/errors.js';

// splitExpense is exercised through the ledger: for a lone expense paid by `payer`,
// each participant's portion is -(balance) after adding back the amount to the payer.
// To read portions directly we use a payer who is not a participant, so
// balances()[name] === -portion for every participant.
function portions(expense) {
  const ledger = createLedger();
  ledger.record({ payer: 'Payer', ...expense });
  const b = ledger.balances();
  const out = {};
  // `0 - x` rather than `-x`: a zero balance must become +0, not -0 (toEqual distinguishes them)
  for (const name of expense.participants) out[name] = 0 - b[name];
  return out;
}

function recordError(expense) {
  const ledger = createLedger();
  try {
    ledger.record({ payer: 'Payer', ...expense });
  } catch (e) {
    return e;
  }
  return null;
}

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

describe('R2 equal split', () => {
  it('gives leftover cents to the alphabetically first names (spec example)', () => {
    expect(portions({ amount: 100, participants: ['Ana', 'Bo', 'Cy'], split: 'equal' }))
      .toEqual({ Ana: 34, Bo: 33, Cy: 33 });
  });

  it('divides evenly when there is no remainder', () => {
    expect(portions({ amount: 90, participants: ['Ana', 'Bo', 'Cy'], split: 'equal' }))
      .toEqual({ Ana: 30, Bo: 30, Cy: 30 });
  });

  it('does not depend on the order participants are listed (spec example)', () => {
    expect(portions({ amount: 100, participants: ['Bo', 'Ana'], split: 'equal' }))
      .toEqual({ Ana: 50, Bo: 50 });
    expect(portions({ amount: 101, participants: ['Bo', 'Ana'], split: 'equal' }))
      .toEqual({ Ana: 51, Bo: 50 });
    expect(portions({ amount: 101, participants: ['Ana', 'Bo'], split: 'equal' }))
      .toEqual({ Ana: 51, Bo: 50 });
  });

  it('gives one extra cent each to the first `remainder` names in ascending order', () => {
    // 11 / 3 = 3 remainder 2 -> the two alphabetically first get 4
    expect(portions({ amount: 11, participants: ['Cy', 'Bo', 'Ana'], split: 'equal' }))
      .toEqual({ Ana: 4, Bo: 4, Cy: 3 });
    // 10 / 4 = 2 remainder 2
    expect(portions({ amount: 10, participants: ['Dee', 'Cy', 'Bo', 'Ana'], split: 'equal' }))
      .toEqual({ Ana: 3, Bo: 3, Cy: 2, Dee: 2 });
  });

  it('orders names by byte order, so uppercase sorts before lowercase', () => {
    // sorted byte order: 'B', 'Z', 'a'; 2 leftover cents go to 'B' and 'Z'
    expect(portions({ amount: 2, participants: ['a', 'B', 'Z'], split: 'equal' }))
      .toEqual({ B: 1, Z: 1, a: 0 });
  });

  it('treats names case-sensitively', () => {
    expect(portions({ amount: 100, participants: ['ana', 'Ana'], split: 'equal' }))
      .toEqual({ Ana: 50, ana: 50 });
  });

  it('gives zero to later names when the amount is smaller than the head count', () => {
    expect(portions({ amount: 1, participants: ['Bo', 'Ana'], split: 'equal' }))
      .toEqual({ Ana: 1, Bo: 0 });
  });

  it('gives the whole amount to a single participant', () => {
    expect(portions({ amount: 777, participants: ['Ana'], split: 'equal' })).toEqual({ Ana: 777 });
  });

  it('always sums to the amount', () => {
    for (const amount of [1, 2, 7, 99, 100, 101, 12345]) {
      const p = portions({ amount, participants: ['A', 'B', 'C', 'D', 'E'], split: 'equal' });
      expect(sum(p)).toBe(amount);
    }
  });
});

describe('R3 shares split', () => {
  it('splits by weight with the largest remainder getting the leftover (spec example)', () => {
    expect(portions({ amount: 100, participants: ['Ana', 'Bo'], split: 'shares', shares: { Ana: 1, Bo: 2 } }))
      .toEqual({ Ana: 33, Bo: 67 });
  });

  it('splits exactly when weights divide the amount', () => {
    expect(portions({ amount: 100, participants: ['Ana', 'Bo'], split: 'shares', shares: { Ana: 1, Bo: 3 } }))
      .toEqual({ Ana: 25, Bo: 75 });
    expect(portions({ amount: 120, participants: ['Ana', 'Bo', 'Cy'], split: 'shares', shares: { Ana: 1, Bo: 2, Cy: 3 } }))
      .toEqual({ Ana: 20, Bo: 40, Cy: 60 });
  });

  it('breaks remainder ties toward the alphabetically earlier name', () => {
    // 100 over equal weights 1,1,1: floors 33 each, remainders all equal, 1 leftover -> Ana
    expect(portions({ amount: 100, participants: ['Cy', 'Bo', 'Ana'], split: 'shares', shares: { Ana: 1, Bo: 1, Cy: 1 } }))
      .toEqual({ Ana: 34, Bo: 33, Cy: 33 });
    // 2 cents over 1,1,1: floors 0, two leftovers go to Ana then Bo
    expect(portions({ amount: 2, participants: ['Cy', 'Bo', 'Ana'], split: 'shares', shares: { Ana: 1, Bo: 1, Cy: 1 } }))
      .toEqual({ Ana: 1, Bo: 1, Cy: 0 });
  });

  it('awards leftovers in descending order of remainder, not by name', () => {
    // 10 cents, weights Ana 1, Bo 1, Cy 4 (total 6): products 10,10,40
    // floors 1,1,6 remainders 4,4,4 -> all tie; leftover 2 -> Ana, Bo
    expect(portions({ amount: 10, participants: ['Ana', 'Bo', 'Cy'], split: 'shares', shares: { Ana: 1, Bo: 1, Cy: 4 } }))
      .toEqual({ Ana: 2, Bo: 2, Cy: 6 });
    // 11 cents, weights 2,3,5 (total 10): products 22,33,55
    // floors 2,3,5 remainders 2,3,5 -> leftover 1 goes to Cy (largest remainder)
    expect(portions({ amount: 11, participants: ['Ana', 'Bo', 'Cy'], split: 'shares', shares: { Ana: 2, Bo: 3, Cy: 5 } }))
      .toEqual({ Ana: 2, Bo: 3, Cy: 6 });
  });

  it('ignores share entries for people who are not participants', () => {
    expect(portions({ amount: 100, participants: ['Ana', 'Bo'], split: 'shares', shares: { Ana: 1, Bo: 3, Dee: 50 } }))
      .toEqual({ Ana: 25, Bo: 75 });
  });

  it('always sums to the amount', () => {
    for (const amount of [1, 5, 99, 100, 1001]) {
      const p = portions({ amount, participants: ['A', 'B', 'C'], split: 'shares', shares: { A: 3, B: 5, C: 7 } });
      expect(sum(p)).toBe(amount);
    }
  });

  it('handles very large amounts and weights without precision loss', () => {
    const amount = 9007199254740991; // Number.MAX_SAFE_INTEGER
    const p = portions({ amount, participants: ['Ana', 'Bo'], split: 'shares', shares: { Ana: 1, Bo: 1 } });
    expect(p.Ana + p.Bo).toBe(amount);
    expect(p.Ana).toBe(4503599627370496);
    expect(p.Bo).toBe(4503599627370495);
  });
});

describe('R1 InvalidAmount', () => {
  const base = { participants: ['Ana', 'Bo'], split: 'equal' };

  it.each([
    ['zero', 0],
    ['negative', -100],
    ['fractional cents', 10.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['a numeric string', '100'],
    ['null', null],
    ['undefined', undefined],
    ['beyond the safe integer range', 2 ** 53],
  ])('rejects %s', (_label, amount) => {
    const e = recordError({ ...base, amount });
    expect(e).toBeInstanceOf(InvalidAmount);
    expect(e.name).toBe('InvalidAmount');
  });

  it('rejects a missing expense object', () => {
    expect(() => createLedger().record(undefined)).toThrow(InvalidAmount);
    expect(() => createLedger().record(null)).toThrow(InvalidAmount);
  });

  it('accepts the smallest valid amount', () => {
    expect(portions({ ...base, amount: 1 })).toEqual({ Ana: 1, Bo: 0 });
  });

  it('reports the amount error before any other problem', () => {
    expect(recordError({ amount: 0, participants: [], split: 'bogus' })).toBeInstanceOf(InvalidAmount);
  });

  it('records nothing when the expense is rejected', () => {
    const ledger = createLedger();
    expect(() => ledger.record({ payer: 'Ana', amount: 0, participants: ['Ana'], split: 'equal' })).toThrow(InvalidAmount);
    expect(ledger.balances()).toEqual({});
  });
});

describe('R4 InvalidSplit', () => {
  it('rejects an empty participants list', () => {
    const e = recordError({ amount: 100, participants: [], split: 'equal' });
    expect(e).toBeInstanceOf(InvalidSplit);
    expect(e.name).toBe('InvalidSplit');
  });

  it('rejects a missing or non-array participants value', () => {
    expect(recordError({ amount: 100, split: 'equal' })).toBeInstanceOf(InvalidSplit);
    expect(recordError({ amount: 100, participants: 'Ana', split: 'equal' })).toBeInstanceOf(InvalidSplit);
  });

  it('rejects duplicate participant names', () => {
    expect(recordError({ amount: 100, participants: ['Ana', 'Bo', 'Ana'], split: 'equal' })).toBeInstanceOf(InvalidSplit);
    expect(recordError({ amount: 100, participants: ['Ana', 'Ana'], split: 'shares', shares: { Ana: 1 } })).toBeInstanceOf(InvalidSplit);
  });

  it('rejects empty-string and non-string participant names', () => {
    expect(recordError({ amount: 100, participants: ['Ana', ''], split: 'equal' })).toBeInstanceOf(InvalidSplit);
    expect(recordError({ amount: 100, participants: ['Ana', 42], split: 'equal' })).toBeInstanceOf(InvalidSplit);
  });

  it('rejects a shares split with no shares object', () => {
    expect(recordError({ amount: 100, participants: ['Ana'], split: 'shares' })).toBeInstanceOf(InvalidSplit);
    expect(recordError({ amount: 100, participants: ['Ana'], split: 'shares', shares: null })).toBeInstanceOf(InvalidSplit);
  });

  it('rejects a share weight that is zero', () => {
    expect(recordError({ amount: 100, participants: ['Ana', 'Bo'], split: 'shares', shares: { Ana: 0, Bo: 1 } })).toBeInstanceOf(InvalidSplit);
  });

  it('rejects a share weight that is negative', () => {
    expect(recordError({ amount: 100, participants: ['Ana', 'Bo'], split: 'shares', shares: { Ana: -1, Bo: 2 } })).toBeInstanceOf(InvalidSplit);
  });

  it('rejects a share weight that is not an integer', () => {
    expect(recordError({ amount: 100, participants: ['Ana', 'Bo'], split: 'shares', shares: { Ana: 1.5, Bo: 1 } })).toBeInstanceOf(InvalidSplit);
    expect(recordError({ amount: 100, participants: ['Ana', 'Bo'], split: 'shares', shares: { Ana: '1', Bo: 1 } })).toBeInstanceOf(InvalidSplit);
    expect(recordError({ amount: 100, participants: ['Ana', 'Bo'], split: 'shares', shares: { Ana: NaN, Bo: 1 } })).toBeInstanceOf(InvalidSplit);
  });

  it('rejects a participant that has no share weight', () => {
    expect(recordError({ amount: 100, participants: ['Ana', 'Bo'], split: 'shares', shares: { Ana: 1 } })).toBeInstanceOf(InvalidSplit);
  });

  it('does not treat inherited object properties as share weights', () => {
    expect(recordError({ amount: 100, participants: ['toString'], split: 'shares', shares: {} })).toBeInstanceOf(InvalidSplit);
  });

  it('does not require shares for an equal split', () => {
    expect(recordError({ amount: 100, participants: ['Ana'], split: 'equal' })).toBeNull();
  });

  it('records nothing when the split is rejected', () => {
    const ledger = createLedger();
    expect(() => ledger.record({ payer: 'Ana', amount: 100, participants: [], split: 'equal' })).toThrow(InvalidSplit);
    expect(ledger.balances()).toEqual({});
  });
});

describe('R4 UnknownSplitType', () => {
  it.each([
    ['a different word', 'percent'],
    ['wrong case', 'Equal'],
    ['empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['a number', 1],
  ])('rejects %s', (_label, split) => {
    const e = recordError({ amount: 100, participants: ['Ana'], split });
    expect(e).toBeInstanceOf(UnknownSplitType);
    expect(e.name).toBe('UnknownSplitType');
  });

  it('is reported before participant problems', () => {
    expect(recordError({ amount: 100, participants: [], split: 'percent' })).toBeInstanceOf(UnknownSplitType);
  });

  it('is not an InvalidSplit or InvalidAmount error', () => {
    const e = recordError({ amount: 100, participants: ['Ana'], split: 'percent' });
    expect(e).not.toBeInstanceOf(InvalidSplit);
    expect(e).not.toBeInstanceOf(InvalidAmount);
  });
});
