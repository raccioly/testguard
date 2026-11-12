import { makeError } from "./errors.js";

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byTitle = (a, b) => cmp(a.title.toLowerCase(), b.title.toLowerCase());

const comparators = {
  title: (a, b) => byTitle(a, b) || a.year - b.year,
  year: (a, b) => b.year - a.year || byTitle(a, b),
};

export const SORT_KEYS = ["year", "title"];

export function sortCards(cards, key) {
  if (!Object.hasOwn(comparators, key)) throw makeError("InvalidSortKey", `Unknown sort key: ${key}`);
  return [...cards].sort(comparators[key]);
}
