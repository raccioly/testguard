import { assertIsbn } from './isbn.js';
import { normalizeTitle } from './title.js';
import { parseAuthor } from './author.js';

export { InvalidIsbnError, InvalidTitleError, InvalidAuthorError } from './errors.js';
export { normalizeIsbn, isValidIsbn, assertIsbn } from './isbn.js';
export { normalizeTitle } from './title.js';
export { parseAuthor } from './author.js';

export function createRecord({ isbn, title, authors = [], year } = {}) {
  return {
    isbn: assertIsbn(isbn),
    title: normalizeTitle(title),
    authors: authors.map(parseAuthor),
    year,
  };
}
