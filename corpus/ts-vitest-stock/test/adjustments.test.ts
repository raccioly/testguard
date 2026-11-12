import { describe, it, expect } from 'vitest';
import { InvalidQuantity } from '@/index';
import { seedWarehouse } from './helpers';

describe('receive (R6, partial)', () => {
  it('adds to on-hand for a valid SKU', () => {
    const w = seedWarehouse();
    w.receive('BOLT-01', 5);
    const bolt = w.stockReport().find((e) => e.sku === 'BOLT-01');
    expect(bolt?.onHand).toBe(55);
  });

  it('rejects quantity 0 with InvalidQuantity', () => {
    const w = seedWarehouse();
    expect(() => w.receive('BOLT-01', 0)).toThrow(InvalidQuantity);
  });
});
