import { assertIsbn } from '@shelf/core';
import { RecordNotFoundError } from './errors.js';

export { RecordNotFoundError } from './errors.js';

// Returns [{ decade, count }] in ascending decade order, omitting empty decades.
export function decadeSummary(records) {
  const counts = new Map();
  for (const { year } of records) {
    const decade = Math.floor(year / 10) * 10;
    counts.set(decade, (counts.get(decade) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([decade, count]) => ({ decade, count }));
}

function authorPart({ last, first }) {
  return first ? `${last}, ${[...first][0].toUpperCase()}.` : last;
}

export function citation(record) {
  const [lead] = record.authors;
  let who = lead ? authorPart(lead) : '';
  if (lead && record.authors.length > 1) who += ', et al.';
  const head = who ? `${who} (${record.year})` : `(${record.year})`;
  return `${head}. ${record.title}. ${record.isbn}`;
}

export function citeIsbn(index, isbn) {
  const normalized = assertIsbn(isbn);
  const record = index.byIsbn(normalized);
  if (!record) throw new RecordNotFoundError(`No record for ISBN ${normalized}`);
  return citation(record);
}
