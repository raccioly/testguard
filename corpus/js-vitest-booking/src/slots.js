import { InvalidTimeError, InvalidRangeError, MalformedSlotError } from './errors.js';

const SLOT_RE = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/;
const MIN_DURATION = 15;

export function parseSlot(text) {
  const m = typeof text === 'string' ? SLOT_RE.exec(text) : null;
  if (!m) {
    throw new MalformedSlotError(`Malformed slot: ${JSON.stringify(text)}`);
  }
  const [sh, sm, eh, em] = m.slice(1).map(Number);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) {
    throw new InvalidTimeError(`Invalid time in slot: ${text}`);
  }
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start >= end) {
    throw new InvalidRangeError(`Slot must start before it ends: ${text}`);
  }
  if (start % 15 !== 0 || end % 15 !== 0) {
    throw new InvalidRangeError(`Slot must start and end on a quarter hour: ${text}`);
  }
  if (end - start < MIN_DURATION) {
    throw new InvalidRangeError(`Slot must last at least ${MIN_DURATION} minutes: ${text}`);
  }
  return { start, end };
}

const pad = (n) => String(n).padStart(2, '0');

export function formatTime(minutes) {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export function formatSlot(start, end) {
  return `${formatTime(start)}-${formatTime(end)}`;
}
