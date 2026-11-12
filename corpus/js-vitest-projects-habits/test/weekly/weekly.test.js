import { describe, it, expect } from 'vitest';
import { createTracker } from '../../src/tracker.js';
import { InvalidDateError } from '../../src/errors.js';

// Week under test: Monday 2025-03-10 through Sunday 2025-03-16.
const WEEK = [
  '2025-03-10',
  '2025-03-11',
  '2025-03-12',
  '2025-03-13',
  '2025-03-14',
  '2025-03-15',
  '2025-03-16',
];
const TODAY = '2025-03-16';

function withCheckIns(days, today = TODAY) {
  const t = createTracker();
  for (const d of days) t.checkIn(d, today);
  return t;
}

describe('R8 weekly completion percentage', () => {
  const expected = [
    [0, 0],
    [1, 14],
    [2, 29],
    [3, 43],
    [4, 57],
    [5, 71],
    [6, 86],
    [7, 100],
  ];

  for (const [count, pct] of expected) {
    it(`${count} check-in(s) give ${pct}`, () => {
      const t = withCheckIns(WEEK.slice(0, count));
      expect(t.weeklyCompletion('2025-03-10')).toBe(pct);
    });
  }

  it('a week with no check-ins gives 0 on an empty tracker', () => {
    expect(createTracker().weeklyCompletion('2025-03-12')).toBe(0);
  });

  it('3 check-ins give 43 (42.857 rounds up)', () => {
    const t = withCheckIns(['2025-03-10', '2025-03-12', '2025-03-14']);
    expect(t.weeklyCompletion('2025-03-10')).toBe(43);
  });

  it('1 check-in gives 14 (14.286)', () => {
    const t = withCheckIns(['2025-03-13']);
    expect(t.weeklyCompletion('2025-03-13')).toBe(14);
  });

  it('4 check-ins give 57 (57.143)', () => {
    const t = withCheckIns(['2025-03-10', '2025-03-11', '2025-03-15', '2025-03-16']);
    expect(t.weeklyCompletion('2025-03-10')).toBe(57);
  });

  it('7 check-ins give 100', () => {
    expect(withCheckIns(WEEK).weeklyCompletion('2025-03-16')).toBe(100);
  });

  it('returns an integer between 0 and 100 for every count', () => {
    for (let n = 0; n <= 7; n++) {
      const pct = withCheckIns(WEEK.slice(0, n)).weeklyCompletion('2025-03-10');
      expect(Number.isInteger(pct)).toBe(true);
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });

  it('is the same for every date inside the week (Monday to Sunday)', () => {
    const t = withCheckIns(['2025-03-10', '2025-03-11', '2025-03-14']);
    for (const d of WEEK) expect(t.weeklyCompletion(d)).toBe(43);
  });

  it('asking about a Wednesday reports on the Monday-to-Sunday week containing it', () => {
    const t = withCheckIns(['2025-03-10', '2025-03-16']); // Monday and Sunday of the same week
    expect(t.weeklyCompletion('2025-03-12')).toBe(29);
  });

  it('a Sunday belongs to the week that started the Monday before', () => {
    const t = withCheckIns(['2025-03-10']);
    expect(t.weeklyCompletion('2025-03-16')).toBe(14);
  });

  it('a Monday belongs to the week that starts on it, not the previous week', () => {
    const t = withCheckIns(['2025-03-09', '2025-03-10'], TODAY); // Sunday of prev week, Monday
    expect(t.weeklyCompletion('2025-03-10')).toBe(14);
    expect(t.weeklyCompletion('2025-03-09')).toBe(14);
  });

  it('ignores check-ins in the neighboring weeks', () => {
    const t = withCheckIns(['2025-03-08', '2025-03-09', '2025-03-17', '2025-03-18'], '2025-03-20');
    expect(t.weeklyCompletion('2025-03-12')).toBe(0);
  });

  it('counts a duplicate check-in once', () => {
    const t = withCheckIns(['2025-03-10', '2025-03-10', '2025-03-10']);
    expect(t.weeklyCompletion('2025-03-10')).toBe(14);
  });

  it('freeze days do not count as completed', () => {
    const t = withCheckIns(['2025-03-10']);
    t.freeze('2025-03-11', TODAY);
    t.freeze('2025-03-12', TODAY);
    expect(t.weeklyCompletion('2025-03-10')).toBe(14);
  });

  it('handles a week spanning a year boundary', () => {
    // Monday 2024-12-30 through Sunday 2025-01-05
    const t = withCheckIns(['2024-12-30', '2025-01-01'], '2025-01-10');
    expect(t.weeklyCompletion('2025-01-05')).toBe(29);
    expect(t.weeklyCompletion('2024-12-31')).toBe(29);
  });

  it('handles a week containing a leap day', () => {
    // Monday 2024-02-26 through Sunday 2024-03-03
    const t = withCheckIns(['2024-02-27', '2024-02-29', '2024-03-01'], '2024-03-05');
    expect(t.weeklyCompletion('2024-03-03')).toBe(43);
  });
});

describe('R9 weeks including future days', () => {
  const WED = '2025-03-12';

  it('on a Wednesday with Mon-Tue-Wed checked in, the percentage is 43', () => {
    const t = withCheckIns(['2025-03-10', '2025-03-11', '2025-03-12'], WED);
    expect(t.weeklyCompletion(WED)).toBe(43);
  });

  it('is still 43 when asking about the Monday or the Sunday of that week', () => {
    const t = withCheckIns(['2025-03-10', '2025-03-11', '2025-03-12'], WED);
    expect(t.weeklyCompletion('2025-03-10')).toBe(43);
    expect(t.weeklyCompletion('2025-03-16')).toBe(43);
  });

  it('future days count as not completed, so a full past run cannot reach 100', () => {
    const t = withCheckIns(['2025-03-10', '2025-03-11', '2025-03-12'], WED);
    expect(t.weeklyCompletion(WED)).toBeLessThan(100);
  });

  it('on a Monday with only Monday checked in, the percentage is 14', () => {
    const t = withCheckIns(['2025-03-10'], '2025-03-10');
    expect(t.weeklyCompletion('2025-03-10')).toBe(14);
  });

  it('on a Monday with no check-in yet, the percentage is 0', () => {
    const t = withCheckIns([], '2025-03-10');
    expect(t.weeklyCompletion('2025-03-10')).toBe(0);
  });

  it('a check-in for a future day in the week cannot be recorded, so it stays 0 for that day', () => {
    const t = withCheckIns(['2025-03-12'], WED);
    expect(() => t.checkIn('2025-03-14', WED)).toThrow();
    expect(t.weeklyCompletion(WED)).toBe(14);
  });

  it('later in the same week the same earlier check-ins keep their share', () => {
    const t = withCheckIns(['2025-03-10', '2025-03-11', '2025-03-12'], WED);
    t.checkIn('2025-03-13', '2025-03-13');
    expect(t.weeklyCompletion(WED)).toBe(57);
  });

  it('rejects an invalid date with InvalidDateError and the exact message', () => {
    const t = createTracker();
    let err;
    try {
      t.weeklyCompletion('2025-02-30');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidDateError);
    expect(err.message).toBe('Invalid date: 2025-02-30');
  });

  it('rejects other malformed dates passed to the weekly query', () => {
    const t = createTracker();
    expect(() => t.weeklyCompletion('2025-1-5')).toThrow(InvalidDateError);
    expect(() => t.weeklyCompletion('2025-13-01')).toThrow(InvalidDateError);
    expect(() => t.weeklyCompletion('garbage')).toThrow(InvalidDateError);
  });
});
