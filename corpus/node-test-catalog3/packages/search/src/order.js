const fold = (title) => title.toLowerCase();

// Title (case-insensitive) ascending, then year ascending. Ties are left to the
// stable sort, which preserves indexing order.
export function compareRecords(a, b) {
  const ta = fold(a.title);
  const tb = fold(b.title);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.year - b.year;
}

export function sortRecords(records) {
  return [...records].sort(compareRecords);
}
