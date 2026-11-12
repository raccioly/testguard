import { describe, it, expect } from 'vitest';
import { Warehouse } from '@/index';
import { seedWarehouse } from './helpers';

describe('reportTotals (R13, partial)', () => {
  it('counts the SKUs of a seeded warehouse', () => {
    expect(seedWarehouse().reportTotals().skuCount).toBe(3);
  });

  it('returns all four values 0 for an empty warehouse', () => {
    expect(new Warehouse().reportTotals()).toEqual({
      skuCount: 0,
      onHand: 0,
      reserved: 0,
      available: 0,
    });
  });
});
