import { describe, it, expect } from 'vitest';
import { summarizeSlot } from '../src/summary.js';
import {
  InvalidTimeError,
  InvalidRangeError,
  MalformedSlotError,
  UnknownCustomerError,
} from '../src/errors.js';

describe('summarizeSlot (R12)', () => {
  it('combines slot, duration and member price', () => {
    // Spec example says "$30.00", but the source prices 09:30-11:00 as 1000 + 3000 = 4000 cents.
    expect(summarizeSlot('09:30-11:00', 'member')).toBe('09:30-11:00 (1h 30m) $40.00');
  });

  it('uses the drop-in price for drop-in customers', () => {
    expect(summarizeSlot('09:30-11:00', 'dropin')).toBe('09:30-11:00 (1h 30m) $80.00');
  });

  it('omits the zero minutes part in the duration', () => {
    expect(summarizeSlot('10:00-11:00', 'member')).toBe('10:00-11:00 (1h) $30.00');
  });

  it('omits the zero hours part in the duration', () => {
    expect(summarizeSlot('10:00-10:15', 'member')).toBe('10:00-10:15 (15m) $7.50');
  });

  it('formats the price with two digits of cents', () => {
    expect(summarizeSlot('08:00-08:15', 'member')).toBe('08:00-08:15 (15m) $5.00');
  });

  it('applies the member discount for 4+ hour bookings', () => {
    expect(summarizeSlot('08:00-12:00', 'member')).toBe('08:00-12:00 (4h) $90.00');
  });

  it('never discounts drop-in bookings', () => {
    expect(summarizeSlot('08:00-12:00', 'dropin')).toBe('08:00-12:00 (4h) $200.00');
  });

  it('uses thousands separators for large totals', () => {
    // drop-in 08:00-20:00: 2h off (8000) + 6h peak (36000) + 4h off (16000) = 60000 cents
    expect(summarizeSlot('08:00-20:00', 'dropin')).toBe('08:00-20:00 (12h) $600.00');
    // 00:00-23:45 drop-in: 10h off (40000) + 6h peak (36000) + 7h45 off (31000) = 107000
    expect(summarizeSlot('00:00-23:45', 'dropin')).toBe('00:00-23:45 (23h 45m) $1,070.00');
  });

  it('echoes the input slot text verbatim', () => {
    const out = summarizeSlot('13:15-14:45', 'member');
    expect(out.startsWith('13:15-14:45 (')).toBe(true);
    expect(out).toBe('13:15-14:45 (1h 30m) $45.00');
  });

  it('has the shape "<slot> (<duration>) <money>"', () => {
    expect(summarizeSlot('12:00-13:00', 'member')).toMatch(
      /^\d{2}:\d{2}-\d{2}:\d{2} \(.+\) \$[\d,]+\.\d{2}$/,
    );
  });

  describe('errors', () => {
    it('raises MalformedSlotError for a malformed slot', () => {
      expect(() => summarizeSlot('9:30-11:00', 'member')).toThrow(MalformedSlotError);
    });

    it('raises InvalidTimeError for an out-of-range time', () => {
      expect(() => summarizeSlot('24:00-25:00', 'member')).toThrow(InvalidTimeError);
    });

    it('raises InvalidRangeError for an invalid range', () => {
      expect(() => summarizeSlot('10:00-10:00', 'member')).toThrow(InvalidRangeError);
      expect(() => summarizeSlot('10:00-10:10', 'member')).toThrow(InvalidRangeError);
    });

    it('raises UnknownCustomerError for an unknown customer type', () => {
      expect(() => summarizeSlot('09:30-11:00', 'guest')).toThrow(UnknownCustomerError);
    });

    it('raises UnknownCustomerError for a missing customer type', () => {
      expect(() => summarizeSlot('09:30-11:00')).toThrow(UnknownCustomerError);
    });

    it('is case-sensitive about customer types', () => {
      expect(() => summarizeSlot('09:30-11:00', 'Member')).toThrow(UnknownCustomerError);
    });

    it('reports the slot error first when both slot and customer are invalid', () => {
      expect(() => summarizeSlot('bad', 'guest')).toThrow(MalformedSlotError);
    });
  });
});
