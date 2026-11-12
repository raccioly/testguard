import { test, expect } from '@playwright/test';
import { validateCard, normalizeTags, loadCards, allTags } from '../src/cards.js';

const base = () => ({ id: 'x1', title: 'Title', photographer: 'Person', year: 2000, tags: ['a'] });

function errorOf(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

function expectInvalid(card, field) {
  const err = errorOf(() => validateCard(card));
  expect(err).not.toBeNull();
  expect(err.name).toBe('InvalidCard');
  expect(err.message).toBe(`Invalid card: ${field}`);
}

test.describe('validateCard (R8)', () => {
  test('a valid card is returned unchanged', () => {
    const c = base();
    expect(validateCard(c)).toBe(c);
  });

  test('title: empty, whitespace-only, missing and non-string', () => {
    expectInvalid({ ...base(), title: '' }, 'title');
    expectInvalid({ ...base(), title: '   ' }, 'title');
    expectInvalid({ ...base(), title: undefined }, 'title');
    expectInvalid({ ...base(), title: 42 }, 'title');
  });

  test('photographer: empty, whitespace-only, missing and non-string', () => {
    expectInvalid({ ...base(), photographer: '' }, 'photographer');
    expectInvalid({ ...base(), photographer: ' \t ' }, 'photographer');
    expectInvalid({ ...base(), photographer: null }, 'photographer');
    expectInvalid({ ...base(), photographer: 7 }, 'photographer');
  });

  test('year boundaries 1825/1826/2026/2027', () => {
    expectInvalid({ ...base(), year: 1825 }, 'year');
    expect(() => validateCard({ ...base(), year: 1826 })).not.toThrow();
    expect(() => validateCard({ ...base(), year: 2026 })).not.toThrow();
    expectInvalid({ ...base(), year: 2027 }, 'year');
  });

  test('year must be an integer number', () => {
    expectInvalid({ ...base(), year: 2000.5 }, 'year');
    expectInvalid({ ...base(), year: '2000' }, 'year');
    expectInvalid({ ...base(), year: NaN }, 'year');
    expectInvalid({ ...base(), year: undefined }, 'year');
  });

  test('tags: not an array, or containing an empty/blank/non-string entry', () => {
    expectInvalid({ ...base(), tags: 'a' }, 'tags');
    expectInvalid({ ...base(), tags: undefined }, 'tags');
    expectInvalid({ ...base(), tags: ['a', ''] }, 'tags');
    expectInvalid({ ...base(), tags: ['a', '   '] }, 'tags');
    expectInvalid({ ...base(), tags: ['a', 3] }, 'tags');
  });

  test('an empty tags array is valid', () => {
    expect(() => validateCard({ ...base(), tags: [] })).not.toThrow();
  });

  test('the first failing field wins, in order title, photographer, year, tags', () => {
    const allBad = { title: '', photographer: '', year: 1, tags: 'x' };
    expectInvalid(allBad, 'title');
    expectInvalid({ ...allBad, title: 'T' }, 'photographer');
    expectInvalid({ ...allBad, title: 'T', photographer: 'P' }, 'year');
    expectInvalid({ ...allBad, title: 'T', photographer: 'P', year: 2000 }, 'tags');
  });

  test('a missing card is rejected as title', () => {
    expectInvalid(undefined, 'title');
    expectInvalid(null, 'title');
  });
});

test.describe('normalizeTags (R9)', () => {
  test('trims, lowercases and de-duplicates keeping first-occurrence order', () => {
    expect(normalizeTags(['Portrait', ' portrait', 'Night'])).toEqual(['portrait', 'night']);
  });

  test('keeps the first-occurrence position of a duplicate', () => {
    expect(normalizeTags(['B', 'a', 'b', 'A', 'c'])).toEqual(['b', 'a', 'c']);
  });

  test('empty list stays empty and input is not mutated', () => {
    expect(normalizeTags([])).toEqual([]);
    const input = [' X ', 'x'];
    normalizeTags(input);
    expect(input).toEqual([' X ', 'x']);
  });
});

test.describe('loadCards (R8, R9, R10)', () => {
  test('normalizes tags on every card and preserves other fields and order', () => {
    const raw = [
      { id: 'a', title: 'One', photographer: 'P', year: 1900, tags: ['Portrait', ' portrait', 'Night'] },
      { id: 'b', title: 'Two', photographer: 'Q', year: 1950, tags: [' Street '] },
    ];
    const out = loadCards(raw);
    expect(out).toEqual([
      { id: 'a', title: 'One', photographer: 'P', year: 1900, tags: ['portrait', 'night'] },
      { id: 'b', title: 'Two', photographer: 'Q', year: 1950, tags: ['street'] },
    ]);
    // raw input untouched
    expect(raw[0].tags).toEqual(['Portrait', ' portrait', 'Night']);
  });

  test('rejects an invalid card with InvalidCard', () => {
    const err = errorOf(() => loadCards([base(), { ...base(), id: 'x2', year: 1825 }]));
    expect(err.name).toBe('InvalidCard');
    expect(err.message).toBe('Invalid card: year');
  });

  test('accepts boundary years 1826 and 2026', () => {
    const out = loadCards([
      { ...base(), id: 'lo', year: 1826 },
      { ...base(), id: 'hi', year: 2026 },
    ]);
    expect(out.map((c) => c.year)).toEqual([1826, 2026]);
  });

  test('rejects year 2027', () => {
    const err = errorOf(() => loadCards([{ ...base(), year: 2027 }]));
    expect(err.name).toBe('InvalidCard');
    expect(err.message).toBe('Invalid card: year');
  });

  test('duplicate ids are rejected with DuplicateCardId', () => {
    const err = errorOf(() => loadCards([base(), { ...base(), title: 'Other' }]));
    expect(err).not.toBeNull();
    expect(err.name).toBe('DuplicateCardId');
    expect(err.message).toBe('Duplicate card id: x1');
  });

  test('distinct ids are accepted', () => {
    expect(loadCards([base(), { ...base(), id: 'x2' }])).toHaveLength(2);
  });

  test('empty input loads to an empty list', () => {
    expect(loadCards([])).toEqual([]);
  });
});

test.describe('allTags (R9)', () => {
  test('union of normalized tags, sorted alphabetically', () => {
    const cards = loadCards([
      { id: 'a', title: 'A', photographer: 'P', year: 1900, tags: ['Night', 'street'] },
      { id: 'b', title: 'B', photographer: 'P', year: 1900, tags: ['street', 'Architecture'] },
    ]);
    expect(allTags(cards)).toEqual(['architecture', 'night', 'street']);
  });
});
