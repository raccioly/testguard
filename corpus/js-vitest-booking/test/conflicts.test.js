import { describe, it, expect } from 'vitest';
import { slotsConflict, findConflicts, freeGaps, findFreeGaps } from '../src/conflicts.js';
import {
  InvalidTimeError,
  InvalidRangeError,
  MalformedSlotError,
} from '../src/errors.js';

const slot = (start, end) => ({ start, end });

describe('slotsConflict (R4)', () => {
  it('detects a partial overlap', () => {
    expect(slotsConflict(slot(540, 600), slot(585, 630))).toBe(true);
  });

  it('is symmetric for overlaps', () => {
    expect(slotsConflict(slot(585, 630), slot(540, 600))).toBe(true);
  });

  it('does not conflict when slots merely touch (a ends where b starts)', () => {
    expect(slotsConflict(slot(540, 600), slot(600, 660))).toBe(false);
  });

  it('does not conflict when slots merely touch (b ends where a starts)', () => {
    expect(slotsConflict(slot(600, 660), slot(540, 600))).toBe(false);
  });

  it('conflicts when they overlap by exactly one minute', () => {
    expect(slotsConflict(slot(540, 601), slot(600, 660))).toBe(true);
  });

  it('detects containment in both directions', () => {
    expect(slotsConflict(slot(540, 720), slot(600, 660))).toBe(true);
    expect(slotsConflict(slot(600, 660), slot(540, 720))).toBe(true);
  });

  it('detects identical slots', () => {
    expect(slotsConflict(slot(540, 600), slot(540, 600))).toBe(true);
  });

  it('does not conflict for disjoint slots with a gap', () => {
    expect(slotsConflict(slot(540, 600), slot(660, 720))).toBe(false);
    expect(slotsConflict(slot(660, 720), slot(540, 600))).toBe(false);
  });
});

describe('findConflicts (R4, R5)', () => {
  it('reports no conflict for slots that merely touch', () => {
    expect(findConflicts(['09:00-10:00'], '10:00-11:00')).toEqual([]);
    expect(findConflicts(['10:00-11:00'], '09:00-10:00')).toEqual([]);
  });

  it('reports a conflict for the R4 overlap example', () => {
    expect(findConflicts(['09:00-10:00'], '09:45-10:30')).toEqual(['09:00-10:00']);
  });

  it('reports a one-quarter-hour overlap', () => {
    expect(findConflicts(['09:00-10:00'], '09:45-10:45')).toEqual(['09:00-10:00']);
    expect(findConflicts(['09:00-10:00'], '08:15-09:15')).toEqual(['09:00-10:00']);
  });

  it('returns an empty array for no existing bookings', () => {
    expect(findConflicts([], '09:00-10:00')).toEqual([]);
  });

  it('returns an empty array when the proposed slot is free', () => {
    expect(findConflicts(['08:00-09:00', '11:00-12:00'], '09:00-11:00')).toEqual([]);
  });

  it('returns only the conflicting bookings', () => {
    const existing = ['08:00-09:00', '09:30-10:30', '12:00-13:00'];
    expect(findConflicts(existing, '10:00-12:00')).toEqual(['09:30-10:30']);
  });

  it('returns conflicts in original input order, not sorted by time', () => {
    const existing = ['14:00-15:00', '09:00-10:00', '11:00-12:00'];
    expect(findConflicts(existing, '09:00-15:00')).toEqual([
      '14:00-15:00',
      '09:00-10:00',
      '11:00-12:00',
    ]);
  });

  it('returns the original strings, not parsed objects', () => {
    const result = findConflicts(['09:00-10:00'], '09:30-10:30');
    expect(typeof result[0]).toBe('string');
  });

  it('keeps duplicate bookings', () => {
    expect(findConflicts(['09:00-10:00', '09:00-10:00'], '09:15-09:30')).toEqual([
      '09:00-10:00',
      '09:00-10:00',
    ]);
  });

  it('detects a proposed slot fully inside an existing booking', () => {
    expect(findConflicts(['09:00-12:00'], '10:00-11:00')).toEqual(['09:00-12:00']);
  });

  it('detects a proposed slot fully containing an existing booking', () => {
    expect(findConflicts(['10:00-11:00'], '09:00-12:00')).toEqual(['10:00-11:00']);
  });

  it('does not mutate its inputs', () => {
    const existing = ['10:00-11:00', '09:00-10:00'];
    const copy = [...existing];
    findConflicts(existing, '09:30-10:30');
    expect(existing).toEqual(copy);
  });
});

describe('findConflicts - invalid input (R5)', () => {
  it('raises MalformedSlotError for a malformed existing booking', () => {
    expect(() => findConflicts(['9:00-10:00'], '09:00-10:00')).toThrow(MalformedSlotError);
  });

  it('raises MalformedSlotError for a malformed proposed slot', () => {
    expect(() => findConflicts(['09:00-10:00'], 'nope')).toThrow(MalformedSlotError);
  });

  it('raises InvalidTimeError for an invalid existing booking', () => {
    expect(() => findConflicts(['09:60-10:00'], '09:00-10:00')).toThrow(InvalidTimeError);
  });

  it('raises InvalidTimeError for an invalid proposed slot', () => {
    expect(() => findConflicts(['09:00-10:00'], '24:00-25:00')).toThrow(InvalidTimeError);
  });

  it('raises InvalidRangeError for an invalid existing booking', () => {
    expect(() => findConflicts(['10:00-10:00'], '09:00-10:00')).toThrow(InvalidRangeError);
  });

  it('raises InvalidRangeError for an invalid proposed slot', () => {
    expect(() => findConflicts(['09:00-10:00'], '10:00-10:10')).toThrow(InvalidRangeError);
  });

  it('raises even when the bad booking comes after a conflicting one', () => {
    expect(() => findConflicts(['09:00-10:00', 'bad'], '09:00-10:00')).toThrow(
      MalformedSlotError,
    );
  });

  it('raises even when the bad booking would not conflict', () => {
    expect(() => findConflicts(['09:00-10:00', '19:10-19:20'], '09:00-10:00')).toThrow(
      InvalidRangeError,
    );
  });

  it('validates existing bookings before the proposed slot', () => {
    expect(() => findConflicts(['bad'], '24:00-25:00')).toThrow(MalformedSlotError);
  });
});

describe('freeGaps (R6)', () => {
  it('returns the whole window with no bookings', () => {
    expect(freeGaps([])).toEqual(['08:00-20:00']);
  });

  it('returns gaps around touching bookings (R6 example)', () => {
    expect(freeGaps(['09:00-10:00', '10:00-11:30'])).toEqual(['08:00-09:00', '11:30-20:00']);
  });

  it('returns gaps between separate bookings', () => {
    expect(freeGaps(['09:00-10:00', '12:00-13:00'])).toEqual([
      '08:00-09:00',
      '10:00-12:00',
      '13:00-20:00',
    ]);
  });

  it('merges overlapping bookings', () => {
    expect(freeGaps(['09:00-11:00', '10:00-12:00'])).toEqual(['08:00-09:00', '12:00-20:00']);
  });

  it('merges a booking contained in another', () => {
    expect(freeGaps(['09:00-13:00', '10:00-11:00'])).toEqual(['08:00-09:00', '13:00-20:00']);
  });

  it('sorts unsorted input', () => {
    expect(freeGaps(['14:00-15:00', '09:00-10:00'])).toEqual([
      '08:00-09:00',
      '10:00-14:00',
      '15:00-20:00',
    ]);
  });

  it('handles duplicate bookings', () => {
    expect(freeGaps(['09:00-10:00', '09:00-10:00'])).toEqual(['08:00-09:00', '10:00-20:00']);
  });

  it('returns no gaps when the whole window is booked', () => {
    expect(freeGaps(['08:00-20:00'])).toEqual([]);
  });

  it('returns no gaps when consecutive bookings cover the window', () => {
    expect(freeGaps(['08:00-12:00', '12:00-20:00'])).toEqual([]);
  });

  it('omits the leading gap when booked from 08:00', () => {
    expect(freeGaps(['08:00-09:00'])).toEqual(['09:00-20:00']);
  });

  it('omits the trailing gap when booked until 20:00', () => {
    expect(freeGaps(['19:00-20:00'])).toEqual(['08:00-19:00']);
  });

  it('keeps a gap of one quarter hour', () => {
    expect(freeGaps(['08:00-09:00', '09:15-20:00'])).toEqual(['09:00-09:15']);
  });

  it('clips a booking that starts before 08:00', () => {
    expect(freeGaps(['07:00-09:00'])).toEqual(['09:00-20:00']);
  });

  it('clips a booking that ends after 20:00', () => {
    expect(freeGaps(['19:00-21:00'])).toEqual(['08:00-19:00']);
  });

  it('clips a booking extending past both ends', () => {
    expect(freeGaps(['06:00-22:00'])).toEqual([]);
  });

  it('ignores a booking entirely before 08:00', () => {
    expect(freeGaps(['06:00-07:00'])).toEqual(['08:00-20:00']);
  });

  it('ignores a booking that ends exactly at 08:00', () => {
    expect(freeGaps(['07:00-08:00'])).toEqual(['08:00-20:00']);
  });

  it('ignores a booking entirely after 20:00', () => {
    expect(freeGaps(['21:00-22:00'])).toEqual(['08:00-20:00']);
  });

  it('ignores a booking that starts exactly at 20:00', () => {
    expect(freeGaps(['20:00-21:00'])).toEqual(['08:00-20:00']);
  });

  it('merges clipped and in-window bookings', () => {
    expect(freeGaps(['07:00-09:00', '09:00-10:00', '19:00-21:00'])).toEqual(['10:00-19:00']);
  });

  it('does not mutate its input', () => {
    const bookings = ['14:00-15:00', '09:00-10:00'];
    const copy = [...bookings];
    freeGaps(bookings);
    expect(bookings).toEqual(copy);
  });

  it('exposes findFreeGaps as an alias', () => {
    expect(findFreeGaps).toBe(freeGaps);
  });

  it('raises MalformedSlotError for a malformed booking', () => {
    expect(() => freeGaps(['9:00-10:00'])).toThrow(MalformedSlotError);
  });

  it('raises InvalidTimeError for an invalid booking', () => {
    expect(() => freeGaps(['09:00-10:60'])).toThrow(InvalidTimeError);
  });

  it('raises InvalidRangeError for an invalid booking', () => {
    expect(() => freeGaps(['10:00-10:10'])).toThrow(InvalidRangeError);
  });

  it('raises for an invalid booking even when it lies outside the window', () => {
    expect(() => freeGaps(['06:00-06:10'])).toThrow(InvalidRangeError);
  });
});
