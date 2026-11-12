import { InvalidDateError } from './errors.js';

const DAY_MS = 86400000;
const FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/** Returns the UTC epoch-ms of a valid YYYY-MM-DD string, or NaN. */
function toEpoch(text) {
  if (typeof text !== 'string' || !FORMAT.test(text)) return NaN;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCFullYear(y);
  const ok =
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d;
  return ok ? date.getTime() : NaN;
}

export function isValidDate(text) {
  return !Number.isNaN(toEpoch(text));
}

/** Parses a date, throwing InvalidDateError on bad input. Returns epoch-ms. */
export function parseDate(text) {
  const ms = toEpoch(text);
  if (Number.isNaN(ms)) throw new InvalidDateError(text);
  return ms;
}

export function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Adds (possibly negative) days to a valid date string. */
export function addDays(text, days) {
  return formatDate(parseDate(text) + days * DAY_MS);
}

/** Monday of the Monday-to-Sunday week containing the date. */
export function weekStart(text) {
  const ms = parseDate(text);
  const offset = (new Date(ms).getUTCDay() + 6) % 7;
  return formatDate(ms - offset * DAY_MS);
}
