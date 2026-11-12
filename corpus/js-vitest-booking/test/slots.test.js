import { describe, it, expect } from 'vitest';
import { parseSlot, formatTime, formatSlot } from '../src/slots.js';
import {
  InvalidTimeError,
  InvalidRangeError,
  MalformedSlotError,
} from '../src/errors.js';

const errorOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

describe('parseSlot - valid input (R1)', () => {
  it('parses 09:30-11:00 into minutes after midnight', () => {
    expect(parseSlot('09:30-11:00')).toEqual({ start: 570, end: 660 });
  });

  it('parses the earliest possible slot', () => {
    expect(parseSlot('00:00-00:15')).toEqual({ start: 0, end: 15 });
  });

  it('parses the latest possible slot ending at 23:45', () => {
    expect(parseSlot('23:30-23:45')).toEqual({ start: 1410, end: 1425 });
  });

  it('accepts a slot of exactly 15 minutes', () => {
    expect(parseSlot('10:00-10:15')).toEqual({ start: 600, end: 615 });
  });

  it('accepts a slot spanning most of the day', () => {
    expect(parseSlot('00:00-23:45')).toEqual({ start: 0, end: 1425 });
  });

  it('accepts all four quarter-hour minute values', () => {
    expect(parseSlot('01:00-01:15')).toEqual({ start: 60, end: 75 });
    expect(parseSlot('01:15-01:30')).toEqual({ start: 75, end: 90 });
    expect(parseSlot('01:30-01:45')).toEqual({ start: 90, end: 105 });
    expect(parseSlot('01:45-02:00')).toEqual({ start: 105, end: 120 });
  });
});

describe('parseSlot - MalformedSlotError (R3 format check)', () => {
  it.each([
    ['single-digit start hour', '9:30-11:00'],
    ['single-digit end hour', '09:30-9:00'],
    ['spaces around the hyphen', '09:30 - 11:00'],
    ['empty string', ''],
    ['leading whitespace', ' 09:30-11:00'],
    ['trailing whitespace', '09:30-11:00 '],
    ['trailing newline', '09:30-11:00\n'],
    ['en dash instead of hyphen', '09:30\u201311:00'],
    ['dot instead of colon', '09.30-11.00'],
    ['missing end', '09:30-'],
    ['missing start', '-11:00'],
    ['only one time', '09:30'],
    ['three digit hour', '009:30-11:00'],
    ['three digit minutes', '09:300-11:00'],
    ['letters', 'ab:cd-ef:gh'],
    ['extra trailing text', '09:30-11:00-12:00'],
    ['prefix text', 'x09:30-11:00'],
    ['negative-looking input', '-9:30-11:00'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseSlot(input)).toThrow(MalformedSlotError);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 930],
    ['an object', {}],
    ['an array', ['09:30-11:00']],
  ])('rejects non-string input: %s', (_label, input) => {
    expect(() => parseSlot(input)).toThrow(MalformedSlotError);
  });

  it('sets the error name and is an Error instance', () => {
    const e = errorOf(() => parseSlot('nope'));
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(MalformedSlotError);
    expect(e.name).toBe('MalformedSlotError');
  });

  it('does not report a malformed slot as the other error classes', () => {
    const e = errorOf(() => parseSlot('9:30-11:00'));
    expect(e).not.toBeInstanceOf(InvalidTimeError);
    expect(e).not.toBeInstanceOf(InvalidRangeError);
  });
});

describe('parseSlot - InvalidTimeError (R2)', () => {
  it.each([
    ['24:00-25:00 (both hours out of range)', '24:00-25:00'],
    ['09:60-10:00 (start minutes out of range)', '09:60-10:00'],
    ['09:00-10:60 (end minutes out of range)', '09:00-10:60'],
    ['24:00-23:00 (start hour 24)', '24:00-23:00'],
    ['23:00-24:00 (end hour 24)', '23:00-24:00'],
    ['09:99-10:00', '09:99-10:00'],
    ['99:00-10:00', '99:00-10:00'],
    ['00:00-00:60', '00:00-00:60'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseSlot(input)).toThrow(InvalidTimeError);
  });

  it('sets the error name', () => {
    const e = errorOf(() => parseSlot('24:00-25:00'));
    expect(e).toBeInstanceOf(InvalidTimeError);
    expect(e.name).toBe('InvalidTimeError');
  });

  it('is not an InvalidRangeError or MalformedSlotError', () => {
    const e = errorOf(() => parseSlot('09:60-10:00'));
    expect(e).not.toBeInstanceOf(InvalidRangeError);
    expect(e).not.toBeInstanceOf(MalformedSlotError);
  });

  it('accepts the boundary values 23 and 59 as valid times', () => {
    // 23:59 is a legal clock time; it only fails the quarter-hour rule
    expect(() => parseSlot('23:45-23:59')).toThrow(InvalidRangeError);
    expect(() => parseSlot('23:45-23:59')).not.toThrow(InvalidTimeError);
  });
});

describe('parseSlot - InvalidRangeError (R3)', () => {
  it.each([
    ['zero-length slot', '10:00-10:00'],
    ['end before start', '11:00-10:00'],
    ['end one quarter before start', '10:15-10:00'],
    ['start not on a quarter hour', '10:10-10:30'],
    ['end not on a quarter hour', '10:00-10:10'],
    ['both off quarter hour', '10:05-10:50'],
    ['minute 59 end', '10:00-10:59'],
    ['minute 01 start', '10:01-11:00'],
    ['zero-length at midnight', '00:00-00:00'],
    ['off-grid zero-length', '10:05-10:05'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseSlot(input)).toThrow(InvalidRangeError);
  });

  it('sets the error name', () => {
    const e = errorOf(() => parseSlot('10:00-10:00'));
    expect(e).toBeInstanceOf(InvalidRangeError);
    expect(e.name).toBe('InvalidRangeError');
  });

  it('is not an InvalidTimeError or MalformedSlotError', () => {
    const e = errorOf(() => parseSlot('11:00-10:00'));
    expect(e).not.toBeInstanceOf(InvalidTimeError);
    expect(e).not.toBeInstanceOf(MalformedSlotError);
  });
});

describe('parseSlot - order of checks (format, then R2, then R3)', () => {
  it('format check beats the time check', () => {
    // would also have hour 25, but is malformed first
    expect(() => parseSlot('9:30-25:00')).toThrow(MalformedSlotError);
  });

  it('format check beats the range check', () => {
    expect(() => parseSlot('11:0-10:00')).toThrow(MalformedSlotError);
  });

  it('time check beats the range check (end before start AND hour out of range)', () => {
    expect(() => parseSlot('25:00-10:00')).toThrow(InvalidTimeError);
  });

  it('time check beats the range check (zero length AND minutes out of range)', () => {
    expect(() => parseSlot('10:60-10:60')).toThrow(InvalidTimeError);
  });

  it('time check beats the quarter-hour check', () => {
    expect(() => parseSlot('10:05-10:61')).toThrow(InvalidTimeError);
  });

  it('time check beats the range check for an out-of-range end hour', () => {
    expect(() => parseSlot('23:00-24:00')).toThrow(InvalidTimeError);
  });

  it('a reversed slot is reported as a range error, not a time error', () => {
    expect(() => parseSlot('23:45-00:00')).toThrow(InvalidRangeError);
    expect(() => parseSlot('23:45-00:00')).not.toThrow(InvalidTimeError);
  });
});

describe('formatTime and formatSlot helpers', () => {
  it('formats minutes after midnight as HH:MM', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(570)).toBe('09:30');
    expect(formatTime(1425)).toBe('23:45');
  });

  it('formats a slot from start and end minutes', () => {
    expect(formatSlot(570, 660)).toBe('09:30-11:00');
  });

  it('round-trips with parseSlot', () => {
    const { start, end } = parseSlot('08:15-17:45');
    expect(formatSlot(start, end)).toBe('08:15-17:45');
  });
});
