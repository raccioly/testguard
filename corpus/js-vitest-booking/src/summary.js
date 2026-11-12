import { parseSlot } from './slots.js';
import { priceSlot } from './pricing.js';
import { formatDuration, formatMoney } from './format/index.js';

export function summarizeSlot(text, customerType) {
  const { start, end } = parseSlot(text);
  const price = priceSlot(text, customerType);
  return `${text} (${formatDuration(end - start)}) ${formatMoney(price)}`;
}
