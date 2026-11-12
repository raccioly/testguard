import { describe, it, expect } from 'vitest';
import {
  MissingPrice,
  MixedCustomerTypes,
  ReservationNotActive,
  Warehouse,
} from '@/index';

const T = 1_700_000_000_000;
const HOUR = 3_600_000;

function capture(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected function to throw');
}

function stocked(): Warehouse {
  const w = new Warehouse();
  w.receive('ITEM-A', 500);
  w.receive('ITEM-B', 500);
  return w;
}

describe('priceOrder subtotal and member discount (R8, R9)', () => {
  it('sums quantity times unit price across reservations', () => {
    const w = stocked();
    const r1 = w.reserve('ITEM-A', 2, 'guest', T);
    const r2 = w.reserve('ITEM-B', 3, 'guest', T);
    const q = w.priceOrder([r1.id, r2.id], { 'ITEM-A': 100, 'ITEM-B': 250 });
    expect(q).toEqual({ subtotal: 950, discount: 0, total: 950 });
  });

  it('gives a member order 10% off', () => {
    const w = stocked();
    const r = w.reserve('ITEM-A', 10, 'member', T);
    const q = w.priceOrder([r.id], { 'ITEM-A': 200 });
    expect(q).toEqual({ subtotal: 2000, discount: 200, total: 1800 });
  });

  it('gives a guest order no percentage discount', () => {
    const w = stocked();
    const r = w.reserve('ITEM-A', 10, 'guest', T);
    const q = w.priceOrder([r.id], { 'ITEM-A': 200 });
    expect(q).toEqual({ subtotal: 2000, discount: 0, total: 2000 });
  });

  it('rounds half up for percentage discounts', () => {
    const w = stocked();
    const r = w.reserve('ITEM-A', 1, 'member', T);
    // 10% of 5 is 0.5, rounded half up to 1
    expect(w.priceOrder([r.id], { 'ITEM-A': 5 })).toEqual({
      subtotal: 5,
      discount: 1,
      total: 4,
    });
  });

  it('rounds down when the fraction is below one half', () => {
    const w = stocked();
    const r = w.reserve('ITEM-A', 1, 'member', T);
    // 10% of 4 is 0.4, rounded to 0
    expect(w.priceOrder([r.id], { 'ITEM-A': 4 })).toEqual({
      subtotal: 4,
      discount: 0,
      total: 4,
    });
  });

  it('prices only the listed reservations', () => {
    const w = stocked();
    const r1 = w.reserve('ITEM-A', 1, 'guest', T);
    w.reserve('ITEM-B', 1, 'guest', T);
    const q = w.priceOrder([r1.id], { 'ITEM-A': 100, 'ITEM-B': 999 });
    expect(q.subtotal).toBe(100);
  });
});

describe('priceOrder bulk rule (R10)', () => {
  it("matches the spec's rounding example: subtotal 12345, 100 units, member", () => {
    const w = stocked();
    const a = w.reserve('ITEM-A', 99, 'member', T);
    const b = w.reserve('ITEM-B', 1, 'member', T);
    // 99 * 123 + 1 * 168 = 12345
    const q = w.priceOrder([a.id, b.id], { 'ITEM-A': 123, 'ITEM-B': 168 });
    expect(q).toEqual({ subtotal: 12345, discount: 1852, total: 10493 });
  });

  it('applies no bulk discount at 99 units for a guest', () => {
    const w = stocked();
    const r = w.reserve('ITEM-A', 99, 'guest', T);
    expect(w.priceOrder([r.id], { 'ITEM-A': 10 })).toEqual({
      subtotal: 990,
      discount: 0,
      total: 990,
    });
  });

  it('applies an extra 5% at exactly 100 units for a guest', () => {
    const w = stocked();
    const r = w.reserve('ITEM-A', 100, 'guest', T);
    expect(w.priceOrder([r.id], { 'ITEM-A': 10 })).toEqual({
      subtotal: 1000,
      discount: 50,
      total: 950,
    });
  });

  it('gives a member only 10% at 99 units', () => {
    const w = stocked();
    const r = w.reserve('ITEM-A', 99, 'member', T);
    expect(w.priceOrder([r.id], { 'ITEM-A': 10 })).toEqual({
      subtotal: 990,
      discount: 99,
      total: 891,
    });
  });

  it('gives a member 15% (not compounded) at exactly 100 units', () => {
    const w = stocked();
    const r = w.reserve('ITEM-A', 100, 'member', T);
    expect(w.priceOrder([r.id], { 'ITEM-A': 10 })).toEqual({
      subtotal: 1000,
      discount: 150,
      total: 850,
    });
  });

  it('counts units across several reservations toward the threshold', () => {
    const w = stocked();
    const a = w.reserve('ITEM-A', 60, 'guest', T);
    const b = w.reserve('ITEM-B', 40, 'guest', T);
    const q = w.priceOrder([a.id, b.id], { 'ITEM-A': 10, 'ITEM-B': 10 });
    expect(q).toEqual({ subtotal: 1000, discount: 50, total: 950 });
  });

  it('applies the bulk rule above 100 units', () => {
    const w = stocked();
    const r = w.reserve('ITEM-A', 200, 'guest', T);
    expect(w.priceOrder([r.id], { 'ITEM-A': 10 })).toEqual({
      subtotal: 2000,
      discount: 100,
      total: 1900,
    });
  });
});

describe('priceOrder errors (R8, R9)', () => {
  it('fails with MissingPrice when a SKU is absent from the price table', () => {
    const w = stocked();
    const a = w.reserve('ITEM-A', 1, 'guest', T);
    const b = w.reserve('ITEM-B', 1, 'guest', T);
    const err = capture(() => w.priceOrder([a.id, b.id], { 'ITEM-A': 100 }));
    expect(err).toBeInstanceOf(MissingPrice);
    expect(err.name).toBe('MissingPrice');
  });

  it('fails with MixedCustomerTypes for member and guest reservations', () => {
    const w = stocked();
    const m = w.reserve('ITEM-A', 1, 'member', T);
    const g = w.reserve('ITEM-B', 1, 'guest', T);
    const err = capture(() => w.priceOrder([m.id, g.id], { 'ITEM-A': 100, 'ITEM-B': 100 }));
    expect(err).toBeInstanceOf(MixedCustomerTypes);
    expect(err.name).toBe('MixedCustomerTypes');
  });

  it('fails with ReservationNotActive for a released reservation', () => {
    const w = stocked();
    const a = w.reserve('ITEM-A', 1, 'guest', T);
    const b = w.reserve('ITEM-B', 1, 'guest', T);
    w.release(b.id);
    const err = capture(() => w.priceOrder([a.id, b.id], { 'ITEM-A': 100, 'ITEM-B': 100 }));
    expect(err).toBeInstanceOf(ReservationNotActive);
    expect(err.name).toBe('ReservationNotActive');
  });

  it('fails with ReservationNotActive for an expired reservation', () => {
    const w = stocked();
    const a = w.reserve('ITEM-A', 1, 'guest', T);
    w.sweep(T + 2 * HOUR);
    expect(() => w.priceOrder([a.id], { 'ITEM-A': 100 })).toThrow(ReservationNotActive);
  });
});
