import { describe, it, expect } from 'vitest';
import { createTracker } from '../../src/tracker.js';

function build(checkIns, freezes = [], today = '2025-03-31') {
  const t = createTracker();
  for (const d of checkIns) t.checkIn(d, today);
  for (const d of freezes) t.freeze(d, today);
  return t;
}

describe('R5 current streak', () => {
  it('is 0 with no data', () => {
    expect(createTracker().currentStreak('2025-03-10')).toBe(0);
  });

  it('is 1 for a lone check-in today', () => {
    const t = build(['2025-03-10'], [], '2025-03-10');
    expect(t.currentStreak('2025-03-10')).toBe(1);
  });

  it('counts consecutive days ending today', () => {
    const t = build(['2025-03-08', '2025-03-09', '2025-03-10'], [], '2025-03-10');
    expect(t.currentStreak('2025-03-10')).toBe(3);
  });

  it('stays alive from yesterday when today has no check-in', () => {
    const t = build(['2025-03-08', '2025-03-09'], [], '2025-03-10');
    expect(t.currentStreak('2025-03-10')).toBe(2);
  });

  it('is 0 when neither today nor yesterday has a check-in', () => {
    const t = build(['2025-03-07', '2025-03-08'], [], '2025-03-10');
    expect(t.currentStreak('2025-03-10')).toBe(0);
  });

  it('is 0 when only an older check-in exists', () => {
    const t = build(['2025-03-01'], [], '2025-03-10');
    expect(t.currentStreak('2025-03-10')).toBe(0);
  });

  it('stops at the first gap', () => {
    const t = build(['2025-03-05', '2025-03-06', '2025-03-08', '2025-03-09', '2025-03-10'], [], '2025-03-10');
    expect(t.currentStreak('2025-03-10')).toBe(3);
  });

  it('counts across a month boundary', () => {
    const t = build(['2025-02-27', '2025-02-28', '2025-03-01', '2025-03-02'], [], '2025-03-02');
    expect(t.currentStreak('2025-03-02')).toBe(4);
  });

  it('counts across a year boundary', () => {
    const t = build(['2024-12-30', '2024-12-31', '2025-01-01'], [], '2025-01-01');
    expect(t.currentStreak('2025-01-01')).toBe(3);
  });

  it('counts across a leap day', () => {
    const t = build(['2024-02-28', '2024-02-29', '2024-03-01'], [], '2024-03-01');
    expect(t.currentStreak('2024-03-01')).toBe(3);
  });

  it('a check-in today with a gap yesterday starts a new streak of 1', () => {
    const t = build(['2025-03-07', '2025-03-08', '2025-03-10'], [], '2025-03-10');
    expect(t.currentStreak('2025-03-10')).toBe(1);
  });

  it('a freeze day today does not count and yesterday keeps the streak alive', () => {
    const t = build(['2025-03-08', '2025-03-09'], ['2025-03-10'], '2025-03-10');
    expect(t.currentStreak('2025-03-10')).toBe(2);
  });

  it('is 0 when yesterday is only a freeze day and today has no check-in', () => {
    const t = build(['2025-03-07'], ['2025-03-09'], '2025-03-10');
    expect(t.currentStreak('2025-03-10')).toBe(0);
  });
});

describe('R6 freeze rule', () => {
  it("spec example: check-ins 03-01, 03-02, 03-04 with 03-03 frozen give a streak of 3", () => {
    const t = build(['2025-03-01', '2025-03-02', '2025-03-04'], ['2025-03-03'], '2025-03-04');
    expect(t.currentStreak('2025-03-04')).toBe(3);
    expect(t.longestStreak()).toBe(3);
  });

  it('spec example: without the freeze the run ending 03-04 has length 1 and the longest is 2', () => {
    const t = build(['2025-03-01', '2025-03-02', '2025-03-04'], [], '2025-03-04');
    expect(t.currentStreak('2025-03-04')).toBe(1);
    expect(t.longestStreak()).toBe(2);
  });

  it('a freeze day contributes 0 to the length', () => {
    const t = build(['2025-03-01', '2025-03-03'], ['2025-03-02'], '2025-03-03');
    expect(t.currentStreak('2025-03-03')).toBe(2);
  });

  it('two consecutive frozen days break the streak', () => {
    const t = build(['2025-03-01', '2025-03-04'], ['2025-03-02', '2025-03-03'], '2025-03-04');
    expect(t.currentStreak('2025-03-04')).toBe(1);
    expect(t.longestStreak()).toBe(1);
  });

  it('a frozen day followed by an unfrozen empty day breaks the streak', () => {
    const t = build(['2025-03-01', '2025-03-05'], ['2025-03-02', '2025-03-03'], '2025-03-05');
    expect(t.currentStreak('2025-03-05')).toBe(1);
  });

  it('two consecutive days without check-ins, none frozen, break the streak', () => {
    const t = build(['2025-03-01', '2025-03-04'], [], '2025-03-04');
    expect(t.currentStreak('2025-03-04')).toBe(1);
  });

  it('an unfrozen gap of one day breaks the streak', () => {
    const t = build(['2025-03-01', '2025-03-03'], [], '2025-03-03');
    expect(t.currentStreak('2025-03-03')).toBe(1);
  });

  it('multiple gaps may each be bridged by their own freeze day', () => {
    const t = build(
      ['2025-03-01', '2025-03-03', '2025-03-05'],
      ['2025-03-02', '2025-03-04'],
      '2025-03-05',
    );
    expect(t.currentStreak('2025-03-05')).toBe(3);
    expect(t.longestStreak()).toBe(3);
  });

  it('a freeze bridge works with a longer run on each side', () => {
    const t = build(
      ['2025-03-01', '2025-03-02', '2025-03-03', '2025-03-05', '2025-03-06'],
      ['2025-03-04'],
      '2025-03-06',
    );
    expect(t.currentStreak('2025-03-06')).toBe(5);
  });

  it('a freeze bridge works across a month boundary', () => {
    const t = build(['2025-02-27', '2025-03-01'], ['2025-02-28'], '2025-03-01');
    expect(t.currentStreak('2025-03-01')).toBe(2);
  });

  it('a freeze bridge keeps the streak alive when counting back from yesterday', () => {
    const t = build(['2025-03-01', '2025-03-03'], ['2025-03-02'], '2025-03-04');
    expect(t.currentStreak('2025-03-04')).toBe(2);
  });

  it('a freeze day that is not between two check-ins does not extend the streak', () => {
    const t = build(['2025-03-03', '2025-03-04'], ['2025-03-02'], '2025-03-04');
    expect(t.currentStreak('2025-03-04')).toBe(2);
    expect(t.longestStreak()).toBe(2);
  });

  it('a freeze day does not create a check-in', () => {
    const t = build([], ['2025-03-02'], '2025-03-04');
    expect(t.currentStreak('2025-03-04')).toBe(0);
    expect(t.longestStreak()).toBe(0);
  });
});

describe('R7 longest streak', () => {
  it('is 0 with no check-ins', () => {
    expect(createTracker().longestStreak()).toBe(0);
  });

  it('is 0 with only freeze days', () => {
    const t = build([], ['2025-03-01', '2025-03-03'], '2025-03-10');
    expect(t.longestStreak()).toBe(0);
  });

  it('is 1 for a single check-in', () => {
    const t = build(['2025-03-05'], [], '2025-03-10');
    expect(t.longestStreak()).toBe(1);
  });

  it('finds the longest run in the middle of the history', () => {
    const t = build(
      ['2025-03-01', '2025-03-03', '2025-03-04', '2025-03-05', '2025-03-06', '2025-03-08', '2025-03-09'],
      [],
      '2025-03-10',
    );
    expect(t.longestStreak()).toBe(4);
    // 2025-03-09 is yesterday, so the 03-08..03-09 run is still alive
    expect(t.currentStreak('2025-03-10')).toBe(2);
  });

  it('is at least the current streak', () => {
    const t = build(['2025-03-01', '2025-03-02', '2025-03-04', '2025-03-05'], [], '2025-03-05');
    expect(t.currentStreak('2025-03-05')).toBe(2);
    expect(t.longestStreak()).toBeGreaterThanOrEqual(t.currentStreak('2025-03-05'));
  });

  it('exceeds the current streak when an older run was longer', () => {
    const t = build(['2025-03-01', '2025-03-02', '2025-03-03', '2025-03-08'], [], '2025-03-08');
    expect(t.currentStreak('2025-03-08')).toBe(1);
    expect(t.longestStreak()).toBe(3);
  });

  it('uses the freeze rules: a bridged run counts, a double-frozen gap does not', () => {
    const t = build(
      ['2025-03-01', '2025-03-03', '2025-03-04', '2025-03-07', '2025-03-08'],
      ['2025-03-02', '2025-03-05', '2025-03-06'],
      '2025-03-10',
    );
    expect(t.longestStreak()).toBe(3);
  });

  it('counts check-ins entered out of order', () => {
    const t = build(['2025-03-04', '2025-03-02', '2025-03-03', '2025-03-01'], [], '2025-03-10');
    expect(t.longestStreak()).toBe(4);
  });

  it('counts across a year boundary', () => {
    const t = build(['2024-12-30', '2024-12-31', '2025-01-01', '2025-01-02'], [], '2025-01-10');
    expect(t.longestStreak()).toBe(4);
  });

  it('is unaffected by duplicate check-ins', () => {
    const t = build(['2025-03-01', '2025-03-01', '2025-03-02'], [], '2025-03-10');
    expect(t.longestStreak()).toBe(2);
  });
});
