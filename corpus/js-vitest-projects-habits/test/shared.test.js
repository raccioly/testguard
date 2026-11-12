import { describe, it, expect } from 'vitest';
import { createTracker } from '../src/tracker.js';
import { ConflictError, FutureDateError, InvalidDateError } from '../src/errors.js';

const TODAY = '2025-03-12'; // a Wednesday, explicit so the real clock is never used

function catchError(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('R1 recording check-ins', () => {
  it('stores a valid check-in for its day', () => {
    const t = createTracker();
    t.checkIn('2025-03-10', TODAY);
    expect(t.longestStreak()).toBe(1);
    expect(t.weeklyCompletion('2025-03-10')).toBe(14);
  });

  it('does not raise for a valid date', () => {
    const t = createTracker();
    expect(() => t.checkIn('2025-03-10', TODAY)).not.toThrow();
  });

  it('recording the same date twice does not raise and counts once', () => {
    const t = createTracker();
    t.checkIn('2025-03-10', TODAY);
    expect(() => t.checkIn('2025-03-10', TODAY)).not.toThrow();
    expect(t.longestStreak()).toBe(1);
    expect(t.weeklyCompletion('2025-03-10')).toBe(14);
  });

  it('recording the same date three times still counts once toward a streak', () => {
    const t = createTracker();
    t.checkIn('2025-03-11', TODAY);
    t.checkIn('2025-03-11', TODAY);
    t.checkIn('2025-03-11', TODAY);
    t.checkIn('2025-03-12', TODAY);
    expect(t.currentStreak(TODAY)).toBe(2);
    expect(t.longestStreak()).toBe(2);
  });

  it('accepts a leap day in a leap year', () => {
    const t = createTracker();
    expect(() => t.checkIn('2024-02-29', TODAY)).not.toThrow();
    expect(t.longestStreak()).toBe(1);
  });
});

describe('R2 invalid dates', () => {
  const invalid = [
    '2025-02-30',
    '2025-13-01',
    '2025-1-5',
    '2025-02-29',
    '2025-04-31',
    '2025-00-10',
    '2025-01-00',
    '2025-03-1',
    '25-03-01',
    '2025/03/01',
    ' 2025-03-01',
    'not-a-date',
    '',
  ];

  for (const input of invalid) {
    it(`rejects "${input}" with InvalidDateError and the exact message`, () => {
      const t = createTracker();
      const err = catchError(() => t.checkIn(input, TODAY));
      expect(err).toBeInstanceOf(InvalidDateError);
      expect(err.name).toBe('InvalidDateError');
      expect(err.message).toBe(`Invalid date: ${input}`);
    });
  }

  it('is an Error subclass', () => {
    const t = createTracker();
    const err = catchError(() => t.checkIn('2025-02-30', TODAY));
    expect(err).toBeInstanceOf(Error);
  });

  it('stores nothing when the date is rejected', () => {
    const t = createTracker();
    expect(() => t.checkIn('2025-02-30', TODAY)).toThrow(InvalidDateError);
    expect(t.longestStreak()).toBe(0);
    expect(t.currentStreak(TODAY)).toBe(0);
    expect(t.weeklyCompletion('2025-03-10')).toBe(0);
  });

  it('reports InvalidDateError even for an out-of-range month that sorts after today', () => {
    const t = createTracker();
    expect(() => t.checkIn('2025-13-01', TODAY)).toThrow(InvalidDateError);
  });
});

describe('R3 future dates', () => {
  it('rejects the day after today with FutureDateError and the exact message', () => {
    const t = createTracker();
    const err = catchError(() => t.checkIn('2025-03-13', TODAY));
    expect(err).toBeInstanceOf(FutureDateError);
    expect(err.name).toBe('FutureDateError');
    expect(err.message).toBe('Check-in date is in the future: 2025-03-13');
  });

  it('rejects a far-future date', () => {
    const t = createTracker();
    const err = catchError(() => t.checkIn('2026-01-01', TODAY));
    expect(err).toBeInstanceOf(FutureDateError);
    expect(err.message).toBe('Check-in date is in the future: 2026-01-01');
  });

  it('accepts a check-in dated today', () => {
    const t = createTracker();
    expect(() => t.checkIn(TODAY, TODAY)).not.toThrow();
    expect(t.currentStreak(TODAY)).toBe(1);
  });

  it('accepts yesterday', () => {
    const t = createTracker();
    expect(() => t.checkIn('2025-03-11', TODAY)).not.toThrow();
  });

  it('compares across month boundaries', () => {
    const t = createTracker();
    expect(() => t.checkIn('2025-02-28', '2025-03-01')).not.toThrow();
    expect(() => t.checkIn('2025-03-02', '2025-03-01')).toThrow(FutureDateError);
  });

  it('compares across year boundaries', () => {
    const t = createTracker();
    expect(() => t.checkIn('2024-12-31', '2025-01-01')).not.toThrow();
    expect(() => t.checkIn('2025-01-02', '2025-01-01')).toThrow(FutureDateError);
  });

  it('stores nothing when the date is in the future', () => {
    const t = createTracker();
    expect(() => t.checkIn('2025-03-13', TODAY)).toThrow(FutureDateError);
    expect(t.longestStreak()).toBe(0);
    expect(t.weeklyCompletion('2025-03-13')).toBe(0);
  });

  it('uses the supplied today, not a fixed one', () => {
    const t = createTracker();
    expect(() => t.checkIn('2025-03-13', '2025-03-13')).not.toThrow();
    expect(() => t.checkIn('2025-03-13', '2025-03-12')).toThrow(FutureDateError);
  });
});

describe('R4 freeze days (partial)', () => {
  it('accepts a freeze day on a date with no check-in', () => {
    const t = createTracker();
    expect(() => t.freeze('2025-03-11', TODAY)).not.toThrow();
  });
});
