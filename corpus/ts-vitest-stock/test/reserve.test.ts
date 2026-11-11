import { describe, it, expect } from 'vitest';
import {
  InsufficientStock,
  InvalidQuantity,
  UnknownSku,
} from '@/index';
import { seedWarehouse } from './helpers';

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

describe('reserve (R1)', () => {
  it('returns an active reservation with the requested details', () => {
    const w = seedWarehouse();
    const r = w.reserve('BOLT-01', 10, 'member', T);
    expect(r).toEqual({
      id: expect.any(String),
      sku: 'BOLT-01',
      quantity: 10,
      customerType: 'member',
      reservedAt: T,
      expiresAt: T + 48 * HOUR,
      status: 'active',
    });
    expect(r.id.length).toBeGreaterThan(0);
  });

  it('reduces available stock by the reserved amount and keeps on-hand', () => {
    const w = seedWarehouse();
    w.reserve('BOLT-01', 10, 'guest', T);
    const bolt = w.stockReport().find((e) => e.sku === 'BOLT-01');
    expect(bolt).toEqual({
      sku: 'BOLT-01',
      onHand: 50,
      reserved: 10,
      available: 40,
      status: 'ok',
    });
  });

  it('does not touch other SKUs', () => {
    const w = seedWarehouse();
    w.reserve('BOLT-01', 10, 'guest', T);
    const nut = w.stockReport().find((e) => e.sku === 'NUT-02');
    expect(nut).toEqual({
      sku: 'NUT-02',
      onHand: 5,
      reserved: 0,
      available: 5,
      status: 'low',
    });
  });

  it('allows reserving exactly the available quantity', () => {
    const w = seedWarehouse();
    const r = w.reserve('NUT-02', 5, 'guest', T);
    expect(r.quantity).toBe(5);
    const nut = w.stockReport().find((e) => e.sku === 'NUT-02');
    expect(nut?.available).toBe(0);
    expect(nut?.status).toBe('out');
  });

  it('gives every reservation a unique id', () => {
    const w = seedWarehouse();
    const a = w.reserve('BOLT-01', 1, 'member', T);
    const b = w.reserve('BOLT-01', 1, 'member', T);
    const c = w.reserve('NUT-02', 1, 'guest', T);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it('accumulates multiple reservations against available stock', () => {
    const w = seedWarehouse();
    w.reserve('BOLT-01', 20, 'member', T);
    w.reserve('BOLT-01', 25, 'guest', T);
    const bolt = w.stockReport().find((e) => e.sku === 'BOLT-01');
    expect(bolt?.reserved).toBe(45);
    expect(bolt?.available).toBe(5);
    expect(bolt?.onHand).toBe(50);
  });
});

describe('reserve rejections (R2)', () => {
  it.each([0, -1, -100, 1.5, 0.1, NaN, Infinity])(
    'rejects quantity %s with InvalidQuantity and the exact message',
    (q) => {
      const w = seedWarehouse();
      const err = capture(() => w.reserve('BOLT-01', q, 'member', T));
      expect(err).toBeInstanceOf(InvalidQuantity);
      expect(err.name).toBe('InvalidQuantity');
      expect(err.message).toBe('quantity must be a positive integer');
    },
  );

  it('rejects an unknown SKU with UnknownSku', () => {
    const w = seedWarehouse();
    const err = capture(() => w.reserve('NOPE-99', 1, 'member', T));
    expect(err).toBeInstanceOf(UnknownSku);
    expect(err.name).toBe('UnknownSku');
  });

  it('rejects a request larger than available with InsufficientStock', () => {
    const w = seedWarehouse();
    const err = capture(() => w.reserve('BOLT-01', 51, 'member', T));
    expect(err).toBeInstanceOf(InsufficientStock);
    expect(err.name).toBe('InsufficientStock');
  });

  it('measures InsufficientStock against available, not on-hand', () => {
    const w = seedWarehouse();
    w.reserve('BOLT-01', 45, 'member', T);
    expect(() => w.reserve('BOLT-01', 6, 'guest', T)).toThrow(InsufficientStock);
    expect(() => w.reserve('BOLT-01', 5, 'guest', T)).not.toThrow();
  });

  it('changes nothing after a rejected reserve (InsufficientStock)', () => {
    const w = seedWarehouse();
    w.reserve('BOLT-01', 10, 'member', T);
    const before = w.stockReport();
    const totalsBefore = w.reportTotals();
    expect(() => w.reserve('BOLT-01', 41, 'guest', T)).toThrow(InsufficientStock);
    expect(w.stockReport()).toEqual(before);
    expect(w.reportTotals()).toEqual(totalsBefore);
  });

  it('changes nothing after a rejected reserve (InvalidQuantity)', () => {
    const w = seedWarehouse();
    const before = w.stockReport();
    expect(() => w.reserve('BOLT-01', 0, 'guest', T)).toThrow(InvalidQuantity);
    expect(() => w.reserve('BOLT-01', 2.5, 'guest', T)).toThrow(InvalidQuantity);
    expect(w.stockReport()).toEqual(before);
  });

  it('changes nothing after a rejected reserve (UnknownSku)', () => {
    const w = seedWarehouse();
    const before = w.stockReport();
    expect(() => w.reserve('NOPE-99', 1, 'guest', T)).toThrow(UnknownSku);
    expect(w.stockReport()).toEqual(before);
  });

  it('does not consume an id slot visible to later reservations as a collision', () => {
    const w = seedWarehouse();
    expect(() => w.reserve('BOLT-01', 999, 'guest', T)).toThrow(InsufficientStock);
    const a = w.reserve('BOLT-01', 1, 'guest', T);
    const b = w.reserve('BOLT-01', 1, 'guest', T);
    expect(a.id).not.toBe(b.id);
  });
});
