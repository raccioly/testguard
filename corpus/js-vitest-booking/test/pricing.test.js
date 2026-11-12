import { describe, it, expect } from 'vitest';
import { priceSlot } from '../src/pricing.js';

// Members only, by design: drop-in pricing and unknown customer types are not covered here.
describe('member pricing - peak/off-peak split (R7, R8)', () => {
  it('charges 2000 cents/hour off-peak before 10:00', () => {
    expect(priceSlot('08:00-09:00', 'member')).toBe(2000);
  });

  it('charges 3000 cents/hour during peak', () => {
    expect(priceSlot('10:00-11:00', 'member')).toBe(3000);
    expect(priceSlot('12:00-13:00', 'member')).toBe(3000);
  });

  it('charges off-peak from 16:00 onward (peak end is exclusive)', () => {
    expect(priceSlot('16:00-17:00', 'member')).toBe(2000);
  });

  it('includes 10:00 as peak (peak start is inclusive)', () => {
    expect(priceSlot('10:00-10:15', 'member')).toBe(750);
    expect(priceSlot('09:45-10:00', 'member')).toBe(500);
  });

  it('splits a slot that straddles the start of peak', () => {
    // 30 min off-peak (1000) + 30 min peak (1500)
    expect(priceSlot('09:30-10:30', 'member')).toBe(2500);
  });

  it('splits a slot that straddles the end of peak', () => {
    // 30 min peak (1500) + 30 min off-peak (1000)
    expect(priceSlot('15:30-16:30', 'member')).toBe(2500);
  });

  it('splits a slot that covers the whole peak window and both sides', () => {
    // 09:00-17:00 = 1h off + 6h peak + 1h off = 2000 + 18000 + 2000 = 22000, 7h so 10% off? no: 8h
    // 8 hours >= 4h, so the discount applies: 22000 * 0.9 = 19800
    expect(priceSlot('09:00-17:00', 'member')).toBe(19800);
  });

  it('prices a quarter hour in each zone', () => {
    expect(priceSlot('09:00-09:15', 'member')).toBe(500);
    expect(priceSlot('15:45-16:00', 'member')).toBe(750);
    expect(priceSlot('16:00-16:15', 'member')).toBe(500);
  });

  it('straddling peak boundaries by a quarter hour', () => {
    expect(priceSlot('09:45-10:15', 'member')).toBe(1250);
    expect(priceSlot('15:45-16:15', 'member')).toBe(1250);
  });
});

describe('member pricing - rounding (R8)', () => {
  it('prices 90 minutes across the boundary without per-minute drift', () => {
    // 09:30-11:00: 30 min off (1000) + 60 min peak (3000)
    expect(priceSlot('09:30-11:00', 'member')).toBe(4000);
  });

  it('returns whole cents (integers)', () => {
    for (const s of ['08:00-08:15', '09:45-10:15', '15:45-16:15', '08:15-11:45']) {
      expect(Number.isInteger(priceSlot(s, 'member'))).toBe(true);
    }
  });

  it('rounds the discounted total half up to a whole cent', () => {
    // 08:15-12:15: 7 quarters off (3500) + 9 quarters peak (6750) = 10250; 4h so discounted
    expect(priceSlot('08:15-12:15', 'member')).toBe(9225);
  });
});

describe('member pricing - 4-hour discount boundary (R9)', () => {
  it('applies no discount at 3h 45m', () => {
    // 08:00-11:45: 2h off (4000) + 1h45 peak (5250) = 9250
    expect(priceSlot('08:00-11:45', 'member')).toBe(9250);
  });

  it('applies the 10 percent discount at exactly 4 hours', () => {
    // 08:00-12:00: 4000 + 6000 = 10000, discounted to 9000
    expect(priceSlot('08:00-12:00', 'member')).toBe(9000);
  });

  it('applies the discount above 4 hours', () => {
    // 08:00-12:15: 4000 + 6750 = 10750 -> 9675
    expect(priceSlot('08:00-12:15', 'member')).toBe(9675);
  });

  it('discounts a 4-hour peak-only booking', () => {
    expect(priceSlot('12:00-16:00', 'member')).toBe(10800);
  });

  it('discounts a 4-hour off-peak-only booking', () => {
    expect(priceSlot('16:00-20:00', 'member')).toBe(7200);
  });

  it('does not discount 3h 45m of off-peak time', () => {
    expect(priceSlot('16:00-19:45', 'member')).toBe(7500);
  });

  it('makes the 4-hour booking cheaper than the 3h45 booking would scale to', () => {
    const justUnder = priceSlot('16:00-19:45', 'member');
    const exactly = priceSlot('16:00-20:00', 'member');
    expect(exactly).toBeLessThan(justUnder);
  });

  it('prices the full 12-hour day at the discounted rate', () => {
    // 4h off + 6h peak + ... = 2h off (4000) + 6h peak (18000) + 4h off (8000) = 30000 -> 27000
    expect(priceSlot('08:00-20:00', 'member')).toBe(27000);
  });
});
