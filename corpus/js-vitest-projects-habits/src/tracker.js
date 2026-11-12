import { ConflictError, FutureDateError } from './errors.js';
import { addDays, parseDate, weekStart } from './dates.js';

export function createTracker() {
  const checkIns = new Set();
  const freezes = new Set();

  function validate(date, today) {
    parseDate(date);
    if (date > today) throw new FutureDateError(date);
  }

  // Length of the streak whose last day is `end` (which must have a check-in).
  // A single frozen day between two check-ins bridges the gap without counting.
  function streakEndingAt(end) {
    let count = 1;
    let cursor = addDays(end, -1);
    for (;;) {
      if (checkIns.has(cursor)) {
        count++;
        cursor = addDays(cursor, -1);
      } else if (freezes.has(cursor) && checkIns.has(addDays(cursor, -1))) {
        cursor = addDays(cursor, -1);
      } else {
        return count;
      }
    }
  }

  return {
    checkIn(date, today) {
      validate(date, today);
      checkIns.add(date);
    },

    freeze(date, today) {
      validate(date, today);
      if (checkIns.has(date)) throw new ConflictError(date);
      freezes.add(date);
    },

    currentStreak(today) {
      if (checkIns.has(today)) return streakEndingAt(today);
      const yesterday = addDays(today, -1);
      if (checkIns.has(yesterday)) return streakEndingAt(yesterday);
      return 0;
    },

    longestStreak() {
      let best = 0;
      for (const day of checkIns) best = Math.max(best, streakEndingAt(day));
      return best;
    },

    weeklyCompletion(date) {
      const start = weekStart(date);
      let done = 0;
      for (let i = 0; i < 7; i++) {
        if (checkIns.has(addDays(start, i))) done++;
      }
      return Math.floor((done * 200 + 7) / 14);
    },
  };
}
