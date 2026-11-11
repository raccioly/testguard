'use strict';

const { EmptyScheduleError, InvalidDayError, InvalidTimeError } = require('./errors');

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function nextSend(reference, days, time) {
  const list = Array.from(days || []);
  if (list.length === 0) {
    throw new EmptyScheduleError('at least one send day is required');
  }
  const wanted = new Set();
  for (const day of list) {
    if (typeof day !== 'string' || !Object.prototype.hasOwnProperty.call(DAYS, day)) {
      throw new InvalidDayError(`invalid day: ${day}`);
    }
    wanted.add(DAYS[day]);
  }
  const match = typeof time === 'string' ? TIME.exec(time) : null;
  if (!match) throw new InvalidTimeError(`invalid time: ${time}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  const ref = reference.getTime();
  const base = Date.UTC(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate(),
    hours,
    minutes
  );
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(base + offset * DAY_MS);
    if (wanted.has(candidate.getUTCDay()) && candidate.getTime() > ref) {
      return candidate;
    }
  }
  /* istanbul ignore next */
  throw new EmptyScheduleError('at least one send day is required');
}

module.exports = { nextSend };
