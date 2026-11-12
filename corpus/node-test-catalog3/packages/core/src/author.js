import { InvalidAuthorError } from './errors.js';

// "Last, First" -> { last, first }; "Voss" -> { last: "Voss", first: "" }.
export function parseAuthor(input) {
  const fail = () => new InvalidAuthorError(`Malformed author name: ${input}`);
  if (typeof input !== 'string') throw fail();
  const parts = input.split(',');
  if (parts.length > 2) throw fail();
  const last = parts[0].trim();
  const first = parts.length === 2 ? parts[1].trim() : '';
  if (last === '') throw fail();
  return { last, first };
}
