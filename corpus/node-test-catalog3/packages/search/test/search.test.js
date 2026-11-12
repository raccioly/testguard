import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createIndex, compareRecords, sortRecords } from '../src/index.js';
import { createRecord } from '@shelf/core';
import { isValidIsbn } from '../../core/src/isbn.js';

const A = '9780306406157';
const B = '9781861972712';
const C = '9780134685991';
const D = '9783161484100';
const E = '9780596517748';
const F = '9781491950296';

const rec = (isbn, title, year, authors = []) => createRecord({ isbn, title, year, authors });

const titles = (list) => list.map((r) => r.title);
const isbns = (list) => list.map((r) => r.isbn);

describe('test fixtures', () => {
  test('every ISBN used to index records is a valid ISBN-13', () => {
    for (const isbn of [A, B, C, D, E, F]) {
      assert.equal(isValidIsbn(isbn), true, isbn);
    }
  });

  test('indexed records carry valid normalized ISBNs', () => {
    const index = createIndex();
    index.add(rec('978-0-306-40615-7', 'One', 2000)).add(rec(B, 'Two', 2001));
    for (const r of index.all()) {
      assert.equal(isValidIsbn(r.isbn), true);
      assert.match(r.isbn, /^[0-9]{13}$/);
    }
  });
});

describe('R6 exact ISBN lookup', () => {
  test('finds the stored record by its normalized ISBN', () => {
    const index = createIndex();
    const r = rec(A, 'The Quiet River', 2004);
    index.add(r);
    assert.equal(index.byIsbn(A), r);
  });

  test('normalizes the query: hyphenated form finds the record (spec example)', () => {
    const index = createIndex();
    const r = rec(A, 'The Quiet River', 2004);
    index.add(r);
    assert.equal(index.byIsbn('978-0-306-40615-7'), r);
    assert.equal(index.byIsbn(' 978 0306406157 '), r);
  });

  test('a record added with a hyphenated ISBN is found by the plain form', () => {
    const index = createIndex();
    const r = { isbn: '978-0-306-40615-7', title: 'The Quiet River', authors: [], year: 2004 };
    index.add(r);
    assert.equal(index.byIsbn(A), r);
  });

  test('returns the single matching record among several', () => {
    const index = createIndex();
    const a = rec(A, 'Alpha', 2000);
    const b = rec(B, 'Beta', 2001);
    const c = rec(C, 'Gamma', 2002);
    index.add(a).add(b).add(c);
    assert.equal(index.byIsbn(B), b);
    assert.equal(index.byIsbn(C), c);
    assert.equal(index.byIsbn(A), a);
  });

  test('a valid ISBN that is not indexed returns null', () => {
    const index = createIndex();
    index.add(rec(A, 'Alpha', 2000));
    assert.equal(index.byIsbn(D), null);
  });

  test('an empty index returns null for a valid ISBN', () => {
    assert.equal(createIndex().byIsbn(A), null);
  });

  test('a wrong check digit throws InvalidIsbnError instead of returning null', () => {
    const index = createIndex();
    index.add(rec(A, 'Alpha', 2000));
    assert.throws(() => index.byIsbn('9780306406158'), {
      name: 'InvalidIsbnError',
      message: 'Invalid ISBN-13: 9780306406158',
    });
  });

  test('wrong length, letters and empty input all throw InvalidIsbnError', () => {
    const index = createIndex();
    for (const bad of ['978030640615', '97803064061570', '978030640615X', 'X780306406157', '']) {
      assert.throws(() => index.byIsbn(bad), { name: 'InvalidIsbnError' }, bad);
    }
  });

  test('add rejects a record whose ISBN is invalid', () => {
    const index = createIndex();
    assert.throws(() => index.add({ isbn: '9780306406158', title: 'X', authors: [], year: 1 }), {
      name: 'InvalidIsbnError',
    });
    assert.deepEqual(index.all(), []);
  });

  test('add returns the index so calls can be chained', () => {
    const index = createIndex();
    assert.equal(index.add(rec(A, 'Alpha', 2000)), index);
  });

  test('indexes are independent of each other', () => {
    const one = createIndex();
    const two = createIndex();
    one.add(rec(A, 'Alpha', 2000));
    assert.equal(two.byIsbn(A), null);
    assert.equal(two.all().length, 0);
  });
});

describe('R7 title prefix search', () => {
  const build = () => {
    const index = createIndex();
    index.add(rec(A, 'The Quiet River', 2004));
    index.add(rec(B, 'Into the Quiet', 2010));
    index.add(rec(C, 'Atlas', 1999));
    return index;
  };

  test('"the qu" matches "The Quiet River" ignoring case (spec example)', () => {
    assert.deepEqual(titles(build().byTitlePrefix('the qu')), ['The Quiet River']);
  });

  test('does not match "Into the Quiet": the match is only at the start', () => {
    const hits = build().byTitlePrefix('the qu');
    assert.ok(!titles(hits).includes('Into the Quiet'));
    assert.deepEqual(titles(build().byTitlePrefix('quiet')), []);
  });

  test('matching ignores case in both the query and the title', () => {
    assert.deepEqual(titles(build().byTitlePrefix('THE QU')), ['The Quiet River']);
    assert.deepEqual(titles(build().byTitlePrefix('tHe qUiEt')), ['The Quiet River']);
    assert.deepEqual(titles(build().byTitlePrefix('into')), ['Into the Quiet']);
  });

  test('a prefix equal to the full title matches', () => {
    assert.deepEqual(titles(build().byTitlePrefix('The Quiet River')), ['The Quiet River']);
  });

  test('a single-letter prefix matches', () => {
    assert.deepEqual(titles(build().byTitlePrefix('a')), ['Atlas']);
  });

  test('a prefix longer than the title does not match', () => {
    assert.deepEqual(build().byTitlePrefix('Atlas of the World'), []);
  });

  test('the query is normalized: surrounding and repeated whitespace is ignored', () => {
    assert.deepEqual(titles(build().byTitlePrefix('  the   qu  ')), ['The Quiet River']);
  });

  test('stored titles are normalized before comparison', () => {
    const index = createIndex();
    const raw = { isbn: A, title: '  The   Quiet River', authors: [], year: 2004 };
    index.add(raw);
    assert.deepEqual(index.byTitlePrefix('the quiet r'), [raw]);
  });

  test('no match returns an empty list', () => {
    assert.deepEqual(build().byTitlePrefix('zzz'), []);
  });

  test('an empty query returns an empty list, not every record', () => {
    assert.deepEqual(build().byTitlePrefix(''), []);
  });

  test('a whitespace-only query returns an empty list', () => {
    assert.deepEqual(build().byTitlePrefix('   '), []);
    assert.deepEqual(build().byTitlePrefix('\t\n'), []);
  });

  test('a non-string query returns an empty list', () => {
    assert.deepEqual(build().byTitlePrefix(undefined), []);
    assert.deepEqual(build().byTitlePrefix(null), []);
    assert.deepEqual(build().byTitlePrefix(5), []);
  });

  test('an empty index returns an empty list', () => {
    assert.deepEqual(createIndex().byTitlePrefix('the'), []);
  });

  test('several matches are all returned', () => {
    const index = createIndex();
    index.add(rec(A, 'Atlas One', 2000));
    index.add(rec(B, 'Atlas Two', 2001));
    index.add(rec(C, 'Basin', 2002));
    assert.deepEqual(titles(index.byTitlePrefix('atlas')), ['Atlas One', 'Atlas Two']);
  });

  test('results come back ordered as in R8', () => {
    const index = createIndex();
    index.add(rec(A, 'Atlas Two', 2001));
    index.add(rec(B, 'Atlas One', 2000));
    assert.deepEqual(titles(index.byTitlePrefix('atlas')), ['Atlas One', 'Atlas Two']);
  });

  test('the returned list is a new array, not shared with the index', () => {
    const index = build();
    const hits = index.byTitlePrefix('the qu');
    hits.pop();
    assert.equal(index.byTitlePrefix('the qu').length, 1);
  });
});

describe('R8 result ordering', () => {
  test('spec example: atlas (1999), Atlas (2010), Basin (1985)', () => {
    const index = createIndex();
    index.add(rec(A, 'Atlas', 2010));
    index.add(rec(B, 'atlas', 1999));
    index.add(rec(C, 'Basin', 1985));
    const out = index.all();
    assert.deepEqual(
      out.map((r) => [r.title, r.year]),
      [
        ['atlas', 1999],
        ['Atlas', 2010],
        ['Basin', 1985],
      ],
    );
  });

  test('the result does not depend on indexing order for distinct sort keys', () => {
    const index = createIndex();
    index.add(rec(C, 'Basin', 1985));
    index.add(rec(B, 'atlas', 1999));
    index.add(rec(A, 'Atlas', 2010));
    assert.deepEqual(isbns(index.all()), [B, A, C]);
  });

  test('titles are compared ignoring case, not by raw code point', () => {
    const index = createIndex();
    index.add(rec(A, 'Zed', 2000));
    index.add(rec(B, 'apple', 2000));
    index.add(rec(C, 'Mango', 2000));
    assert.deepEqual(titles(index.all()), ['apple', 'Mango', 'Zed']);
  });

  test('titles are ordered ascending', () => {
    const index = createIndex();
    index.add(rec(A, 'C', 2000));
    index.add(rec(B, 'A', 2000));
    index.add(rec(C, 'B', 2000));
    assert.deepEqual(titles(index.all()), ['A', 'B', 'C']);
  });

  test('a shorter title that is a prefix of a longer one sorts first', () => {
    const index = createIndex();
    index.add(rec(A, 'Atlas Two', 2000));
    index.add(rec(B, 'Atlas', 2000));
    assert.deepEqual(titles(index.all()), ['Atlas', 'Atlas Two']);
  });

  test('equal titles are ordered by year ascending, not descending', () => {
    const index = createIndex();
    index.add(rec(A, 'Atlas', 2010));
    index.add(rec(B, 'Atlas', 1999));
    index.add(rec(C, 'Atlas', 2004));
    assert.deepEqual(
      index.all().map((r) => r.year),
      [1999, 2004, 2010],
    );
  });

  test('title takes precedence over year', () => {
    const index = createIndex();
    index.add(rec(A, 'Basin', 1900));
    index.add(rec(B, 'Atlas', 2100));
    assert.deepEqual(titles(index.all()), ['Atlas', 'Basin']);
  });

  test('records that fully tie keep indexing order', () => {
    const index = createIndex();
    index.add(rec(C, 'Atlas', 2000));
    index.add(rec(A, 'Atlas', 2000));
    index.add(rec(B, 'Atlas', 2000));
    assert.deepEqual(isbns(index.all()), [C, A, B]);
  });

  test('indexing order is the tie-break whichever order is used', () => {
    const index = createIndex();
    index.add(rec(B, 'Atlas', 2000));
    index.add(rec(A, 'Atlas', 2000));
    assert.deepEqual(isbns(index.all()), [B, A]);
  });

  test('titles differing only by case with equal years keep indexing order', () => {
    const index = createIndex();
    index.add(rec(A, 'atlas', 2000));
    index.add(rec(B, 'Atlas', 2000));
    assert.deepEqual(isbns(index.all()), [A, B]);
    const reversed = createIndex();
    reversed.add(rec(B, 'Atlas', 2000));
    reversed.add(rec(A, 'atlas', 2000));
    assert.deepEqual(isbns(reversed.all()), [B, A]);
  });

  test('a replaced record counts as newly indexed for tie-breaking', () => {
    // Source behavior (comment in createIndex): a replacement moves to the end of the order.
    const index = createIndex();
    index.add(rec(A, 'Atlas', 2000));
    index.add(rec(B, 'Atlas', 2000));
    index.add(rec(A, 'Atlas', 2000));
    assert.deepEqual(isbns(index.all()), [B, A]);
  });

  test('prefix-search results follow the same ordering', () => {
    const index = createIndex();
    index.add(rec(A, 'Atlas', 2010));
    index.add(rec(B, 'atlas', 1999));
    index.add(rec(C, 'Atlas', 2010));
    assert.deepEqual(isbns(index.byTitlePrefix('atl')), [B, A, C]);
  });

  test('an empty index yields an empty list', () => {
    assert.deepEqual(createIndex().all(), []);
  });

  test('compareRecords returns negative, positive and zero as appropriate', () => {
    const a = { title: 'Atlas', year: 2000 };
    const b = { title: 'basin', year: 1990 };
    assert.ok(compareRecords(a, b) < 0);
    assert.ok(compareRecords(b, a) > 0);
    assert.equal(compareRecords(a, { title: 'ATLAS', year: 2000 }), 0);
    assert.ok(compareRecords({ title: 'x', year: 1 }, { title: 'X', year: 2 }) < 0);
  });

  test('sortRecords sorts a copy and leaves the input untouched', () => {
    const input = [
      { title: 'b', year: 1 },
      { title: 'a', year: 1 },
    ];
    const out = sortRecords(input);
    assert.deepEqual(titles(out), ['a', 'b']);
    assert.deepEqual(titles(input), ['b', 'a']);
    assert.notEqual(out, input);
  });
});

describe('R9 duplicate indexing', () => {
  test('re-adding an ISBN replaces the earlier record', () => {
    const index = createIndex();
    const first = rec(A, 'First Title', 2000);
    const second = rec(A, 'Second Title', 2001);
    index.add(first);
    index.add(second);
    assert.equal(index.byIsbn(A), second);
  });

  test('a later prefix search returns the replacing record exactly once', () => {
    const index = createIndex();
    const first = rec(A, 'Atlas', 2000);
    const second = rec(A, 'Atlas', 2005);
    index.add(first);
    index.add(second);
    const hits = index.byTitlePrefix('atlas');
    assert.equal(hits.length, 1);
    assert.equal(hits[0], second);
  });

  test('the old title no longer matches after replacement with a different title', () => {
    const index = createIndex();
    index.add(rec(A, 'Old Name', 2000));
    index.add(rec(A, 'New Name', 2000));
    assert.deepEqual(index.byTitlePrefix('old'), []);
    assert.deepEqual(titles(index.byTitlePrefix('new')), ['New Name']);
  });

  test('the index never holds two records with the same ISBN', () => {
    const index = createIndex();
    index.add(rec(A, 'One', 2000));
    index.add(rec(A, 'Two', 2001));
    index.add(rec(A, 'Three', 2002));
    assert.equal(index.all().length, 1);
    assert.deepEqual(titles(index.all()), ['Three']);
  });

  test('a hyphenated duplicate of the same ISBN also replaces', () => {
    const index = createIndex();
    index.add(rec(A, 'Plain', 2000));
    const hyphenated = { isbn: '978-0-306-40615-7', title: 'Hyphenated', authors: [], year: 2001 };
    index.add(hyphenated);
    assert.equal(index.all().length, 1);
    assert.equal(index.byIsbn(A), hyphenated);
  });

  test('replacing one ISBN does not disturb other records', () => {
    const index = createIndex();
    const other = rec(B, 'Other', 2000);
    index.add(rec(A, 'One', 2000));
    index.add(other);
    index.add(rec(A, 'Uno', 2000));
    assert.equal(index.byIsbn(B), other);
    assert.equal(index.all().length, 2);
  });

  test('distinct ISBNs with the same title are both kept', () => {
    const index = createIndex();
    index.add(rec(A, 'Atlas', 2000));
    index.add(rec(B, 'Atlas', 2000));
    assert.equal(index.byTitlePrefix('atlas').length, 2);
  });
});
