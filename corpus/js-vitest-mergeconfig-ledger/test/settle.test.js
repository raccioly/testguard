import { describe, it, expect } from 'vitest';
import { createLedger } from '../src/ledger.js';

describe('R7 settle-up (partial)', () => {
  it('produces an empty list for an empty ledger', () => {
    expect(createLedger().settleUp()).toEqual([]);
  });

  it('settles a two-person ledger with a single payment', () => {
    const ledger = createLedger();
    ledger.record({ payer: 'Ana', amount: 100, participants: ['Ana', 'Bo'], split: 'equal' });
    expect(ledger.settleUp()).toEqual([{ payer: 'Bo', recipient: 'Ana', amount: 50 }]);
  });
});
