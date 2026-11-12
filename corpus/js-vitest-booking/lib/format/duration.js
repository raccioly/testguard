import { InvalidAmountError } from '../../src/errors.js';

export function formatDuration(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new InvalidAmountError(`Invalid duration: ${String(minutes)}`);
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  return parts.join(' ');
}
