import { parseSlot, formatSlot } from './slots.js';

const DAY_START = 8 * 60;
const DAY_END = 20 * 60;

export function slotsConflict(a, b) {
  return a.start < b.end && b.start < a.end;
}

export function findConflicts(existing, proposed) {
  const parsed = existing.map((text) => ({ text, slot: parseSlot(text) }));
  const target = parseSlot(proposed);
  return parsed.filter(({ slot }) => slotsConflict(slot, target)).map(({ text }) => text);
}

export function freeGaps(bookings) {
  const busy = bookings
    .map(parseSlot)
    .map(({ start, end }) => ({ start: Math.max(start, DAY_START), end: Math.min(end, DAY_END) }))
    .filter(({ start, end }) => start < end)
    .sort((a, b) => a.start - b.start);

  const gaps = [];
  let cursor = DAY_START;
  for (const { start, end } of busy) {
    if (start > cursor) gaps.push(formatSlot(cursor, start));
    cursor = Math.max(cursor, end);
  }
  if (cursor < DAY_END) gaps.push(formatSlot(cursor, DAY_END));
  return gaps;
}

export const findFreeGaps = freeGaps;
