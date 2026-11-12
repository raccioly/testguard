import { describe, it, expect } from 'vitest';
import { ReservationNotActive, UnknownReservation } from '@/index';
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

function boltReserved(w: ReturnType<typeof seedWarehouse>): number {
  return w.stockReport().find((e) => e.sku === 'BOLT-01')!.reserved;
}

function boltAvailable(w: ReturnType<typeof seedWarehouse>): number {
  return w.stockReport().find((e) => e.sku === 'BOLT-01')!.available;
}

describe('release (R3)', () => {
  it('returns the quantity to available stock', () => {
    const w = seedWarehouse();
    const r = w.reserve('BOLT-01', 10, 'member', T);
    expect(boltAvailable(w)).toBe(40);
    const result = w.release(r.id);
    expect(result).toBeUndefined();
    expect(boltAvailable(w)).toBe(50);
    expect(boltReserved(w)).toBe(0);
  });

  it('lets the freed stock be reserved again', () => {
    const w = seedWarehouse();
    const r = w.reserve('NUT-02', 5, 'guest', T);
    w.release(r.id);
    expect(() => w.reserve('NUT-02', 5, 'guest', T)).not.toThrow();
  });

  it('fails with UnknownReservation for an id that does not exist', () => {
    const w = seedWarehouse();
    const err = capture(() => w.release('RES-999'));
    expect(err).toBeInstanceOf(UnknownReservation);
    expect(err.name).toBe('UnknownReservation');
  });

  it('fails with ReservationNotActive when releasing twice', () => {
    const w = seedWarehouse();
    const r = w.reserve('BOLT-01', 10, 'member', T);
    w.release(r.id);
    const err = capture(() => w.release(r.id));
    expect(err).toBeInstanceOf(ReservationNotActive);
    expect(err.name).toBe('ReservationNotActive');
    expect(boltAvailable(w)).toBe(50);
  });

  it('fails with ReservationNotActive when releasing an expired reservation', () => {
    const w = seedWarehouse();
    const r = w.reserve('BOLT-01', 10, 'guest', T);
    w.sweep(T + 2 * HOUR);
    const err = capture(() => w.release(r.id));
    expect(err).toBeInstanceOf(ReservationNotActive);
    expect(err.name).toBe('ReservationNotActive');
  });
});

describe('lifetime (R4)', () => {
  it('sets member expiry 48 hours after the reservation time', () => {
    const w = seedWarehouse();
    const r = w.reserve('BOLT-01', 1, 'member', T);
    expect(r.reservedAt).toBe(T);
    expect(r.expiresAt).toBe(T + 48 * HOUR);
  });

  it('sets guest expiry 2 hours after the reservation time', () => {
    const w = seedWarehouse();
    const r = w.reserve('BOLT-01', 1, 'guest', T);
    expect(r.reservedAt).toBe(T);
    expect(r.expiresAt).toBe(T + 2 * HOUR);
  });

  it('keeps a member reservation active 1 ms before the 48 hour expiry', () => {
    const w = seedWarehouse();
    const r = w.reserve('BOLT-01', 10, 'member', T);
    expect(w.sweep(T + 48 * HOUR - 1)).toBe(0);
    expect(boltReserved(w)).toBe(10);
    expect(() => w.release(r.id)).not.toThrow();
  });

  it('expires a member reservation at exactly the 48 hour instant', () => {
    const w = seedWarehouse();
    const r = w.reserve('BOLT-01', 10, 'member', T);
    expect(w.sweep(T + 48 * HOUR)).toBe(1);
    expect(boltReserved(w)).toBe(0);
    expect(boltAvailable(w)).toBe(50);
    expect(() => w.release(r.id)).toThrow(ReservationNotActive);
  });

  it('keeps a guest reservation active 1 ms before the 2 hour expiry', () => {
    const w = seedWarehouse();
    const r = w.reserve('BOLT-01', 10, 'guest', T);
    expect(w.sweep(T + 2 * HOUR - 1)).toBe(0);
    expect(boltReserved(w)).toBe(10);
    expect(() => w.release(r.id)).not.toThrow();
  });

  it('expires a guest reservation at exactly the 2 hour instant', () => {
    const w = seedWarehouse();
    const r = w.reserve('BOLT-01', 10, 'guest', T);
    expect(w.sweep(T + 2 * HOUR)).toBe(1);
    expect(boltReserved(w)).toBe(0);
    expect(boltAvailable(w)).toBe(50);
    expect(() => w.release(r.id)).toThrow(ReservationNotActive);
  });

  it('does not expire a member reservation at the guest lifetime', () => {
    const w = seedWarehouse();
    w.reserve('BOLT-01', 10, 'member', T);
    expect(w.sweep(T + 2 * HOUR)).toBe(0);
    expect(boltReserved(w)).toBe(10);
  });

  it('counts the lifetime from the reservation time, not from zero', () => {
    const w = seedWarehouse();
    const later = T + 5 * HOUR;
    const r = w.reserve('BOLT-01', 3, 'guest', later);
    expect(r.expiresAt).toBe(later + 2 * HOUR);
    expect(w.sweep(later + 2 * HOUR - 1)).toBe(0);
    expect(w.sweep(later + 2 * HOUR)).toBe(1);
  });
});

describe('sweep (R5)', () => {
  it('returns 0 when there is nothing to expire', () => {
    const w = seedWarehouse();
    expect(w.sweep(T)).toBe(0);
  });

  it('returns the number of reservations expired and frees their quantity', () => {
    const w = seedWarehouse();
    w.reserve('BOLT-01', 10, 'guest', T);
    w.reserve('BOLT-01', 5, 'guest', T);
    w.reserve('NUT-02', 2, 'guest', T);
    expect(w.sweep(T + 3 * HOUR)).toBe(3);
    expect(boltAvailable(w)).toBe(50);
    expect(w.stockReport().find((e) => e.sku === 'NUT-02')?.available).toBe(5);
  });

  it('returns 0 the second time with the same time', () => {
    const w = seedWarehouse();
    w.reserve('BOLT-01', 10, 'guest', T);
    w.reserve('BOLT-01', 10, 'guest', T);
    expect(w.sweep(T + 2 * HOUR)).toBe(2);
    expect(w.sweep(T + 2 * HOUR)).toBe(0);
    expect(boltAvailable(w)).toBe(50);
  });

  it('expires only reservations whose expiry has been reached', () => {
    const w = seedWarehouse();
    w.reserve('BOLT-01', 10, 'guest', T);
    w.reserve('BOLT-01', 7, 'member', T);
    expect(w.sweep(T + 2 * HOUR)).toBe(1);
    expect(boltReserved(w)).toBe(7);
    expect(w.sweep(T + 48 * HOUR)).toBe(1);
    expect(boltReserved(w)).toBe(0);
  });

  it('does not count released reservations', () => {
    const w = seedWarehouse();
    const r = w.reserve('BOLT-01', 10, 'guest', T);
    w.release(r.id);
    expect(w.sweep(T + 3 * HOUR)).toBe(0);
  });

  it('does not re-expire an already expired reservation at a later time', () => {
    const w = seedWarehouse();
    w.reserve('BOLT-01', 10, 'guest', T);
    expect(w.sweep(T + 2 * HOUR)).toBe(1);
    expect(w.sweep(T + 100 * HOUR)).toBe(0);
  });
});
