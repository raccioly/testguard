import { assertIsbn, normalizeTitle } from '@shelf/core';
import { sortRecords } from './order.js';

export { compareRecords, sortRecords } from './order.js';

export function createIndex() {
  const records = new Map(); // normalized ISBN -> record, in indexing order

  return {
    add(record) {
      const key = assertIsbn(record.isbn);
      records.delete(key); // a replacement counts as newly indexed
      records.set(key, record);
      return this;
    },

    byIsbn(isbn) {
      return records.get(assertIsbn(isbn)) ?? null;
    },

    byTitlePrefix(query) {
      if (typeof query !== 'string' || query.trim() === '') return [];
      const prefix = normalizeTitle(query).toLowerCase();
      const hits = [...records.values()].filter((r) =>
        normalizeTitle(r.title).toLowerCase().startsWith(prefix),
      );
      return sortRecords(hits);
    },

    all() {
      return sortRecords(records.values());
    },
  };
}
