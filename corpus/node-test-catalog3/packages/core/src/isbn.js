import { InvalidIsbnError } from './errors.js';

export function normalizeIsbn(input) {
  return typeof input === 'string' ? input.replace(/[-\s]/g, '') : '';
}

export function isValidIsbn(input) {
  const digits = normalizeIsbn(input);
  if (!/^[0-9]{13}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(digits[i]) * (i < 12 && i % 2 === 1 ? 3 : 1);
  return sum % 10 === 0;
}

// Returns the normalized ISBN-13 or throws InvalidIsbnError with the original input.
export function assertIsbn(input) {
  if (!isValidIsbn(input)) throw new InvalidIsbnError(`Invalid ISBN-13: ${input}`);
  return normalizeIsbn(input);
}
