import { InvalidAmountError } from '../../src/errors.js';

export function formatMoney(cents) {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new InvalidAmountError(`Invalid amount: ${String(cents)}`);
  }
  const dollars = Math.floor(cents / 100)
    .toLocaleString('en-US', { useGrouping: false })
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${dollars}.${String(cents % 100).padStart(2, '0')}`;
}
