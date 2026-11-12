import { describe, it, expect } from 'vitest';
import { InvalidFilter, Warehouse } from '@/index';
import { seedWarehouse } from './helpers';

const T = 1_700_000_000_000;

function capture(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected function to throw');
}

function thresholdWarehouse(): Warehouse {
  const w = new Warehouse();
  // received in unsorted order on purpose
  w.receive('ZED-10', 10);
  w.receive('MID-09', 9);
  w.receive('ALP-01', 1);
  w.receive('OUT-00', 4);
  w.receive('BIG-11', 11);
  w.reserve('OUT-00', 4, 'member', T);
  return w;
}

describe('stockReport (R11)', () => {
  it('sorts ascending by SKU', () => {
    const w = thresholdWarehouse();
    expect(w.stockReport().map((e) => e.sku)).toEqual([
      'ALP-01',
      'BIG-11',
      'MID-09',
      'OUT-00',
      'ZED-10',
    ]);
  });

  it('reports every field of every entry at the 0, 1, 9, 10 and 11 thresholds', () => {
    const w = thresholdWarehouse();
    expect(w.stockReport()).toEqual([
      { sku: 'ALP-01', onHand: 1, reserved: 0, available: 1, status: 'low' },
      { sku: 'BIG-11', onHand: 11, reserved: 0, available: 11, status: 'ok' },
      { sku: 'MID-09', onHand: 9, reserved: 0, available: 9, status: 'low' },
      { sku: 'OUT-00', onHand: 4, reserved: 4, available: 0, status: 'out' },
      { sku: 'ZED-10', onHand: 10, reserved: 0, available: 10, status: 'ok' },
    ]);
  });

  it('moves from ok to low when reserving drops available from 10 to 9', () => {
    const w = thresholdWarehouse();
    w.reserve('ZED-10', 1, 'guest', T);
    const e = w.stockReport().find((x) => x.sku === 'ZED-10');
    expect(e).toEqual({ sku: 'ZED-10', onHand: 10, reserved: 1, available: 9, status: 'low' });
  });

  it('counts only active reservations toward reserved', () => {
    const w = seedWarehouse();
    const released = w.reserve('BOLT-01', 10, 'member', T);
    const expiring = w.reserve('BOLT-01', 5, 'guest', T);
    w.reserve('BOLT-01', 3, 'member', T);
    w.release(released.id);
    w.sweep(expiring.expiresAt);
    const bolt = w.stockReport().find((e) => e.sku === 'BOLT-01');
    expect(bolt).toEqual({ sku: 'BOLT-01', onHand: 50, reserved: 3, available: 47, status: 'ok' });
  });

  it('returns an empty array for a warehouse without SKUs', () => {
    expect(new Warehouse().stockReport()).toEqual([]);
  });
});

describe('stockReport filter (R12)', () => {
  it('returns only "out" entries', () => {
    const w = thresholdWarehouse();
    expect(w.stockReport('out').map((e) => e.sku)).toEqual(['OUT-00']);
  });

  it('returns only "low" entries, still sorted by SKU', () => {
    const w = thresholdWarehouse();
    const low = w.stockReport('low');
    expect(low.map((e) => e.sku)).toEqual(['ALP-01', 'MID-09']);
    expect(low.every((e) => e.status === 'low')).toBe(true);
  });

  it('returns only "ok" entries, still sorted by SKU', () => {
    const w = thresholdWarehouse();
    const ok = w.stockReport('ok');
    expect(ok.map((e) => e.sku)).toEqual(['BIG-11', 'ZED-10']);
    expect(ok.every((e) => e.status === 'ok')).toBe(true);
  });

  it('returns an empty array when no entry matches', () => {
    expect(seedWarehouse().stockReport('out')).toEqual([]);
  });

  it('rejects an invalid filter with InvalidFilter and the exact message', () => {
    const w = seedWarehouse();
    const err = capture(() => w.stockReport('bogus' as never));
    expect(err).toBeInstanceOf(InvalidFilter);
    expect(err.name).toBe('InvalidFilter');
    expect(err.message).toBe('status must be one of out, low, ok');
  });

  it('rejects an empty-string filter', () => {
    const w = seedWarehouse();
    expect(() => w.stockReport('' as never)).toThrow(InvalidFilter);
  });
});

describe('reportTotals consistency with stockReport (R13)', () => {
  it('every field equals the column sum of stockReport', () => {
    const w = seedWarehouse();
    w.receive('EXTRA-04', 30);
    w.receive('LAST-05', 7);
    w.reserve('BOLT-01', 12, 'member', T);
    w.reserve('BOLT-01', 8, 'guest', T);
    w.reserve('NUT-02', 5, 'guest', T);
    w.reserve('EXTRA-04', 21, 'member', T);
    const released = w.reserve('LAST-05', 4, 'guest', T);
    w.release(released.id);

    const report = w.stockReport();
    const totals = w.reportTotals();
    expect(totals).toEqual({
      skuCount: report.length,
      onHand: report.reduce((s, e) => s + e.onHand, 0),
      reserved: report.reduce((s, e) => s + e.reserved, 0),
      available: report.reduce((s, e) => s + e.available, 0),
    });
    expect(totals.skuCount).toBe(5);
    expect(totals.reserved).toBe(12 + 8 + 5 + 21);
    expect(totals.onHand).toBe(50 + 5 + 12 + 30 + 7);
  });
});
