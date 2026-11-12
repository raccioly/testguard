import { parseSlot } from './slots.js';
import { UnknownCustomerError } from './errors.js';

const RATES = {
  member: { offPeak: 2000, peak: 3000 },
  dropin: { offPeak: 4000, peak: 6000 },
};
const PEAK_START = 10 * 60;
const PEAK_END = 16 * 60;
const DISCOUNT_MIN_DURATION = 4 * 60;

// Rounds numerator / denominator half up, for non-negative integers.
const divRoundHalfUp = (num, den) => Math.floor((2 * num + den) / (2 * den));

export function priceSlot(text, customerType) {
  const { start, end } = parseSlot(text);
  if (!Object.hasOwn(RATES, customerType)) {
    throw new UnknownCustomerError(`Unknown customer type: ${String(customerType)}`);
  }
  const rates = RATES[customerType];
  const peakMinutes = Math.max(0, Math.min(end, PEAK_END) - Math.max(start, PEAK_START));
  const offPeakMinutes = end - start - peakMinutes;

  let cents = divRoundHalfUp(rates.offPeak * offPeakMinutes + rates.peak * peakMinutes, 60);
  if (customerType === 'member' && end - start >= DISCOUNT_MIN_DURATION) {
    cents = divRoundHalfUp(cents * 9, 10);
  }
  return cents;
}
