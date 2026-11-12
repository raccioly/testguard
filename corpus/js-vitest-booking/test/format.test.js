import { describe, it, expect } from 'vitest';
import { formatDuration, formatMoney } from '../lib/format/index.js';
import { InvalidAmountError } from '../src/errors.js';

describe('formatDuration (R10)', () => {
  it.each([
    [90, '1h 30m'],
    [120, '2h'],
    [45, '45m'],
    [0, '0m'],
    [1, '1m'],
    [59, '59m'],
    [60, '1h'],
    [61, '1h 1m'],
    [119, '1h 59m'],
    [150, '2h 30m'],
    [1440, '24h'],
    [1441, '24h 1m'],
    [600, '10h'],
    [725, '12h 5m'],
  ])('formats %i minutes as %s', (minutes, expected) => {
    expect(formatDuration(minutes)).toBe(expected);
  });

  it('omits the minutes part when it is zero', () => {
    expect(formatDuration(180)).not.toContain('m');
  });

  it('omits the hours part when it is zero', () => {
    expect(formatDuration(30)).not.toContain('h');
  });

  it.each([
    ['negative', -1],
    ['large negative', -90],
    ['fractional', 1.5],
    ['tiny fraction', 0.1],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['numeric string', '90'],
    ['null', null],
    ['undefined', undefined],
    ['object', {}],
  ])('rejects %s input with InvalidAmountError', (_label, input) => {
    expect(() => formatDuration(input)).toThrow(InvalidAmountError);
  });

  it('sets the error name', () => {
    try {
      formatDuration(-5);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidAmountError);
      expect(e.name).toBe('InvalidAmountError');
    }
  });

  it('treats negative zero as zero', () => {
    expect(formatDuration(-0)).toBe('0m');
  });
});

describe('formatMoney (R11)', () => {
  it.each([
    [1250, '$12.50'],
    [5, '$0.05'],
    [0, '$0.00'],
    [123456, '$1,234.56'],
    [1, '$0.01'],
    [9, '$0.09'],
    [10, '$0.10'],
    [99, '$0.99'],
    [100, '$1.00'],
    [101, '$1.01'],
    [99999, '$999.99'],
    [100000, '$1,000.00'],
    [100001, '$1,000.01'],
    [1234567, '$12,345.67'],
    [100000000, '$1,000,000.00'],
    [123456789, '$1,234,567.89'],
    [3000, '$30.00'],
  ])('formats %i cents as %s', (cents, expected) => {
    expect(formatMoney(cents)).toBe(expected);
  });

  it('always has exactly two digits of cents', () => {
    expect(formatMoney(1200)).toMatch(/\.\d{2}$/);
    expect(formatMoney(1205)).toMatch(/\.\d{2}$/);
  });

  it('starts with a dollar sign', () => {
    expect(formatMoney(777).startsWith('$')).toBe(true);
  });

  it('uses comma thousands separators and no others', () => {
    expect(formatMoney(100000000000)).toBe('$1,000,000,000.00');
  });

  it.each([
    ['negative', -1],
    ['large negative', -1250],
    ['fractional', 12.5],
    ['tiny fraction', 0.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['numeric string', '1250'],
    ['null', null],
    ['undefined', undefined],
    ['object', {}],
  ])('rejects %s input with InvalidAmountError', (_label, input) => {
    expect(() => formatMoney(input)).toThrow(InvalidAmountError);
  });

  it('sets the error name', () => {
    try {
      formatMoney(-5);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidAmountError);
      expect(e.name).toBe('InvalidAmountError');
    }
  });

  it('formats negative zero as the source does', () => {
    // Spec is silent on -0 (it is not negative, so not rejected); the source renders it as "$-0.00".
    expect(formatMoney(-0)).toBe('$-0.00');
  });
});
