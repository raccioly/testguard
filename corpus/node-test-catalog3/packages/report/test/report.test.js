import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decadeSummary, citation, citeIsbn, RecordNotFoundError } from '@shelf/report';
import { createIndex } from '@shelf/search';
import { createRecord, InvalidIsbnError } from '@shelf/core';

const A = '9780306406157';
const B = '9781861972712';
const C = '9780134685991';
const D = '9783161484100';

const years = (ys) => ys.map((year) => ({ year }));

describe('R10 counts per decade', () => {
  test('1999 and 2000 fall into the 1990s and the 2000s respectively', () => {
    assert.deepEqual(decadeSummary(years([1999, 2000])), [
      { decade: 1990, count: 1 },
      { decade: 2000, count: 1 },
    ]);
  });

  test('years within one decade are counted together', () => {
    assert.deepEqual(decadeSummary(years([1990, 1995, 1999])), [{ decade: 1990, count: 3 }]);
  });

  test('decade boundaries: x9 stays, x0 starts the next decade', () => {
    assert.deepEqual(decadeSummary(years([2009, 2010])), [
      { decade: 2000, count: 1 },
      { decade: 2010, count: 1 },
    ]);
    assert.deepEqual(decadeSummary(years([1980, 1989])), [{ decade: 1980, count: 2 }]);
  });

  test('decades with no records are omitted', () => {
    assert.deepEqual(decadeSummary(years([1950, 2010])), [
      { decade: 1950, count: 1 },
      { decade: 2010, count: 1 },
    ]);
  });

  test('output is in ascending decade order regardless of input order', () => {
    assert.deepEqual(decadeSummary(years([2015, 1985, 2003, 1991])), [
      { decade: 1980, count: 1 },
      { decade: 1990, count: 1 },
      { decade: 2000, count: 1 },
      { decade: 2010, count: 1 },
    ]);
  });

  test('counts are per record, so repeated years add up', () => {
    assert.deepEqual(decadeSummary(years([2004, 2004, 2001, 2019])), [
      { decade: 2000, count: 3 },
      { decade: 2010, count: 1 },
    ]);
  });

  test('an empty record set yields an empty summary', () => {
    assert.deepEqual(decadeSummary([]), []);
  });

  test('a single record yields a single decade with count 1', () => {
    assert.deepEqual(decadeSummary(years([1987])), [{ decade: 1980, count: 1 }]);
  });

  test('each entry has exactly decade and count', () => {
    const [entry] = decadeSummary(years([2004]));
    assert.deepEqual(Object.keys(entry).sort(), ['count', 'decade']);
  });

  test('works on real Core records indexed through Search', () => {
    const index = createIndex();
    index.add(createRecord({ isbn: A, title: 'Alpha', year: 1999 }));
    index.add(createRecord({ isbn: B, title: 'Beta', year: 2000 }));
    index.add(createRecord({ isbn: C, title: 'Gamma', year: 2004 }));
    assert.deepEqual(decadeSummary(index.all()), [
      { decade: 1990, count: 1 },
      { decade: 2000, count: 2 },
    ]);
  });

  test('a duplicate ISBN replaced in the index is counted once', () => {
    const index = createIndex();
    index.add(createRecord({ isbn: A, title: 'Alpha', year: 1999 }));
    index.add(createRecord({ isbn: A, title: 'Alpha', year: 2001 }));
    assert.deepEqual(decadeSummary(index.all()), [{ decade: 2000, count: 1 }]);
  });

  test('does not modify its input', () => {
    const input = years([2004, 1999]);
    decadeSummary(input);
    assert.deepEqual(input, years([2004, 1999]));
  });
});

describe('R11 citation line (single author with a first name only)', () => {
  test('formats "Last, F. (Year). Title. ISBN" (spec example)', () => {
    const record = createRecord({
      isbn: A,
      title: 'The Quiet River',
      authors: ['Okafor, Ada'],
      year: 2004,
    });
    assert.equal(citation(record), 'Okafor, A. (2004). The Quiet River. 9780306406157');
  });

  test('the initial is the first letter of the first name, uppercased', () => {
    const record = createRecord({
      isbn: A,
      title: 'The Quiet River',
      authors: ['okafor, ada'],
      year: 2004,
    });
    assert.equal(citation(record), 'okafor, A. (2004). The Quiet River. 9780306406157');
  });
});

describe('R12 citation for unknown record', () => {
  const build = () => {
    const index = createIndex();
    index.add(
      createRecord({ isbn: A, title: 'The Quiet River', authors: ['Okafor, Ada'], year: 2004 }),
    );
    return index;
  };

  test('an ISBN that Search does not find fails with RecordNotFoundError', () => {
    assert.throws(() => citeIsbn(build(), B), RecordNotFoundError);
  });

  test('the message is "No record for ISBN " plus the normalized ISBN', () => {
    assert.throws(() => citeIsbn(build(), B), {
      name: 'RecordNotFoundError',
      message: 'No record for ISBN 9781861972712',
    });
  });

  test('a hyphenated unknown ISBN is reported in normalized form', () => {
    assert.throws(() => citeIsbn(build(), '978-1-86197-271-2'), {
      name: 'RecordNotFoundError',
      message: 'No record for ISBN 9781861972712',
    });
  });

  test('an unknown ISBN on an empty index fails the same way', () => {
    assert.throws(() => citeIsbn(createIndex(), D), {
      name: 'RecordNotFoundError',
      message: 'No record for ISBN 9783161484100',
    });
  });

  test('the not-found error is an Error and not an InvalidIsbnError', () => {
    try {
      citeIsbn(build(), B);
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err instanceof RecordNotFoundError);
      assert.ok(!(err instanceof InvalidIsbnError));
      assert.equal(err.name, 'RecordNotFoundError');
    }
  });

  test('an invalid ISBN fails earlier with InvalidIsbnError', () => {
    assert.throws(() => citeIsbn(build(), '9780306406158'), {
      name: 'InvalidIsbnError',
      message: 'Invalid ISBN-13: 9780306406158',
    });
  });

  test('invalid ISBN shapes all give InvalidIsbnError, never RecordNotFoundError', () => {
    for (const bad of ['', '123', '978030640615X', '97803064061570']) {
      assert.throws(() => citeIsbn(build(), bad), InvalidIsbnError, bad);
    }
  });

  test('an invalid ISBN is rejected even on an empty index', () => {
    assert.throws(() => citeIsbn(createIndex(), '9780306406158'), InvalidIsbnError);
  });

  test('a known ISBN returns its citation, including in hyphenated form', () => {
    const expected = 'Okafor, A. (2004). The Quiet River. 9780306406157';
    assert.equal(citeIsbn(build(), A), expected);
    assert.equal(citeIsbn(build(), '978-0-306-40615-7'), expected);
  });

  test('a record replaced in the index is cited from the replacement', () => {
    const index = build();
    index.add(
      createRecord({ isbn: A, title: 'The Loud River', authors: ['Okafor, Ada'], year: 2010 }),
    );
    assert.equal(citeIsbn(index, A), 'Okafor, A. (2010). The Loud River. 9780306406157');
  });
});
