import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTitle,
  parseAuthor,
  createRecord,
  InvalidTitleError,
  InvalidAuthorError,
} from '../src/index.js';

describe('R3 title normalization', () => {
  test('spec example: trims and collapses internal whitespace', () => {
    assert.equal(normalizeTitle('  The   Quiet  River '), 'The Quiet River');
  });

  test('leaves an already clean title untouched', () => {
    assert.equal(normalizeTitle('The Quiet River'), 'The Quiet River');
  });

  test('trims leading and trailing whitespace only', () => {
    assert.equal(normalizeTitle('   Atlas'), 'Atlas');
    assert.equal(normalizeTitle('Atlas   '), 'Atlas');
  });

  test('collapses tabs, newlines and mixed runs to one space', () => {
    assert.equal(normalizeTitle('A\t\tB\n\nC \t D'), 'A B C D');
  });

  test('a single internal space is preserved as a single space', () => {
    assert.equal(normalizeTitle('A B'), 'A B');
  });

  test('preserves letter case', () => {
    assert.equal(normalizeTitle('  tHe QuIeT   RIVER '), 'tHe QuIeT RIVER');
    assert.equal(normalizeTitle('ATLAS'), 'ATLAS');
    assert.equal(normalizeTitle('atlas'), 'atlas');
  });

  test('preserves punctuation and non-ASCII letters', () => {
    assert.equal(normalizeTitle('  Caf\u00e9,   Noir:  A  Study '), 'Caf\u00e9, Noir: A Study');
  });

  test('empty string fails with InvalidTitleError and the exact message', () => {
    assert.throws(() => normalizeTitle(''), {
      name: 'InvalidTitleError',
      message: 'Title must not be empty',
    });
  });

  test('whitespace-only title fails after trimming', () => {
    for (const blank of [' ', '    ', '\t\n ', '\n']) {
      assert.throws(() => normalizeTitle(blank), {
        name: 'InvalidTitleError',
        message: 'Title must not be empty',
      });
    }
  });

  test('non-string title is rejected as empty', () => {
    // Source behavior: non-strings are treated as an empty title.
    assert.throws(() => normalizeTitle(undefined), { name: 'InvalidTitleError' });
    assert.throws(() => normalizeTitle(null), { name: 'InvalidTitleError' });
    assert.throws(() => normalizeTitle(42), { name: 'InvalidTitleError' });
  });

  test('the error is an instance of Error and the exported class', () => {
    try {
      normalizeTitle('  ');
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err instanceof InvalidTitleError);
      assert.equal(err.name, 'InvalidTitleError');
    }
  });

  test('createRecord stores the normalized title', () => {
    const rec = createRecord({
      isbn: '9780306406157',
      title: '  The   Quiet  River ',
      year: 2004,
    });
    assert.equal(rec.title, 'The Quiet River');
  });

  test('createRecord rejects a blank title', () => {
    assert.throws(() => createRecord({ isbn: '9780306406157', title: '   ', year: 2004 }), {
      name: 'InvalidTitleError',
      message: 'Title must not be empty',
    });
  });
});

describe('R4 author name parsing', () => {
  test('class A: "Last, First" yields last and first', () => {
    assert.deepEqual(parseAuthor('Okafor, Ada'), { last: 'Okafor', first: 'Ada' });
  });

  test('class A: whitespace around each part is trimmed (spec example)', () => {
    assert.deepEqual(parseAuthor('Okafor,  Ada '), { last: 'Okafor', first: 'Ada' });
  });

  test('class A: no space after the comma still works', () => {
    assert.deepEqual(parseAuthor('Okafor,Ada'), { last: 'Okafor', first: 'Ada' });
  });

  test('class A: leading whitespace before the last name is trimmed', () => {
    assert.deepEqual(parseAuthor('   Okafor   ,   Ada   '), { last: 'Okafor', first: 'Ada' });
  });

  test('class A: letter case is preserved', () => {
    assert.deepEqual(parseAuthor('okafor, ada'), { last: 'okafor', first: 'ada' });
  });

  test('class A: multi-word first and last names keep their internal spaces', () => {
    assert.deepEqual(parseAuthor('van der Berg, Anna Maria'), {
      last: 'van der Berg',
      first: 'Anna Maria',
    });
  });

  test('class B: a single name has an empty first name (spec example)', () => {
    assert.deepEqual(parseAuthor('Voss'), { last: 'Voss', first: '' });
  });

  test('class B: the whole trimmed string is the last name', () => {
    assert.deepEqual(parseAuthor('  Voss  '), { last: 'Voss', first: '' });
    assert.deepEqual(parseAuthor('Ada Okafor'), { last: 'Ada Okafor', first: '' });
  });

  test('the result has exactly the keys last and first', () => {
    assert.deepEqual(Object.keys(parseAuthor('Voss')).sort(), ['first', 'last']);
    assert.deepEqual(Object.keys(parseAuthor('Okafor, Ada')).sort(), ['first', 'last']);
  });

  test('createRecord parses every author in order', () => {
    const rec = createRecord({
      isbn: '9780306406157',
      title: 'T',
      authors: ['Okafor,  Ada ', 'Voss'],
      year: 2004,
    });
    assert.deepEqual(rec.authors, [
      { last: 'Okafor', first: 'Ada' },
      { last: 'Voss', first: '' },
    ]);
  });

  test('createRecord defaults to no authors', () => {
    const rec = createRecord({ isbn: '9780306406157', title: 'T', year: 2004 });
    assert.deepEqual(rec.authors, []);
  });
});

describe('R5 malformed author rejection', () => {
  test('empty last name (spec example) fails with the exact message', () => {
    assert.throws(() => parseAuthor(', Ada'), {
      name: 'InvalidAuthorError',
      message: 'Malformed author name: , Ada',
    });
  });

  test('whitespace-only last name fails', () => {
    assert.throws(() => parseAuthor('   , Ada'), {
      name: 'InvalidAuthorError',
      message: 'Malformed author name:    , Ada',
    });
  });

  test('empty string fails', () => {
    assert.throws(() => parseAuthor(''), {
      name: 'InvalidAuthorError',
      message: 'Malformed author name: ',
    });
  });

  test('whitespace-only string fails', () => {
    assert.throws(() => parseAuthor('   '), { name: 'InvalidAuthorError' });
  });

  test('a lone comma fails', () => {
    assert.throws(() => parseAuthor(','), {
      name: 'InvalidAuthorError',
      message: 'Malformed author name: ,',
    });
  });

  test('two commas fail and the message keeps the original input unchanged', () => {
    assert.throws(() => parseAuthor('Okafor, Ada, Jr'), {
      name: 'InvalidAuthorError',
      message: 'Malformed author name: Okafor, Ada, Jr',
    });
  });

  test('three or more commas fail', () => {
    assert.throws(() => parseAuthor('A,B,C,D'), {
      name: 'InvalidAuthorError',
      message: 'Malformed author name: A,B,C,D',
    });
  });

  test('two commas fail even when the last name is empty', () => {
    assert.throws(() => parseAuthor(',,'), { name: 'InvalidAuthorError' });
  });

  test('the message preserves surrounding whitespace of the original input', () => {
    assert.throws(() => parseAuthor('  a,b,c  '), {
      name: 'InvalidAuthorError',
      message: 'Malformed author name:   a,b,c  ',
    });
  });

  test('non-string input fails', () => {
    assert.throws(() => parseAuthor(undefined), { name: 'InvalidAuthorError' });
    assert.throws(() => parseAuthor(null), { name: 'InvalidAuthorError' });
    assert.throws(() => parseAuthor(7), {
      name: 'InvalidAuthorError',
      message: 'Malformed author name: 7',
    });
  });

  test('the error is an instance of Error and the exported class', () => {
    try {
      parseAuthor('a,b,c');
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err instanceof InvalidAuthorError);
      assert.equal(err.name, 'InvalidAuthorError');
    }
  });

  test('createRecord rejects a record with a malformed author', () => {
    assert.throws(
      () =>
        createRecord({
          isbn: '9780306406157',
          title: 'T',
          authors: ['Voss', 'a,b,c'],
          year: 2004,
        }),
      { name: 'InvalidAuthorError', message: 'Malformed author name: a,b,c' },
    );
  });

  test('a trailing comma with an empty first name is accepted by the source', () => {
    // Spec does not list "Okafor," as malformed (one comma, non-empty last name);
    // the source yields an empty first name.
    assert.deepEqual(parseAuthor('Okafor,'), { last: 'Okafor', first: '' });
  });
});
