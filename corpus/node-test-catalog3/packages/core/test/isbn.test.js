import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeIsbn,
  isValidIsbn,
  assertIsbn,
  createRecord,
  InvalidIsbnError,
} from '../src/index.js';

const VALID = [
  '9780306406157',
  '9781861972712',
  '9780134685991',
  '9783161484100', // check digit 0
  '9780596517748',
  '9781491950296',
];

describe('R1 ISBN-13 validation', () => {
  test('accepts the spec example and other valid ISBN-13 values', () => {
    for (const isbn of VALID) {
      assert.equal(isValidIsbn(isbn), true, isbn);
    }
  });

  test('rejects the spec example with a wrong check digit', () => {
    assert.equal(isValidIsbn('9780306406158'), false);
  });

  test('rejects every wrong check digit for a valid 12-digit stem', () => {
    const stem = '978030640615';
    for (let d = 0; d <= 9; d++) {
      assert.equal(isValidIsbn(stem + d), d === 7, `check digit ${d}`);
    }
  });

  test('rejects a stem whose check digit would be 0 when given another digit', () => {
    assert.equal(isValidIsbn('9783161484100'), true);
    assert.equal(isValidIsbn('9783161484101'), false);
  });

  test('weights alternate 1 and 3: swapping adjacent digits breaks validity', () => {
    // 9780306406157 with the first two digits swapped.
    assert.equal(isValidIsbn('7980306406157'), false);
    // 9780306406157 with digits at index 3 and 4 swapped (0 and 3).
    assert.equal(isValidIsbn('9783006406157'), false);
  });

  test('accepts hyphenated form', () => {
    assert.equal(isValidIsbn('978-0-306-40615-7'), true);
  });

  test('accepts spaces, tabs and mixed separators', () => {
    assert.equal(isValidIsbn('978 0 306 40615 7'), true);
    assert.equal(isValidIsbn(' 978-0 306\t40615-7 '), true);
  });

  test('normalizeIsbn removes hyphens and spaces', () => {
    assert.equal(normalizeIsbn('978-0-306-40615-7'), '9780306406157');
    assert.equal(normalizeIsbn(' 978 0306406157 '), '9780306406157');
    assert.equal(normalizeIsbn('9780306406157'), '9780306406157');
  });

  test('rejects too-short and too-long digit strings', () => {
    assert.equal(isValidIsbn('978030640615'), false);
    assert.equal(isValidIsbn('97803064061570'), false);
    assert.equal(isValidIsbn('9'), false);
  });

  test('rejects an ISBN-10 even though it is a valid ISBN-10', () => {
    assert.equal(isValidIsbn('0306406152'), false);
  });

  test('rejects empty and whitespace-only input', () => {
    assert.equal(isValidIsbn(''), false);
    assert.equal(isValidIsbn('   '), false);
    assert.equal(isValidIsbn('---'), false);
  });

  test('rejects the letter X in any position', () => {
    assert.equal(isValidIsbn('978030640615X'), false);
    assert.equal(isValidIsbn('X780306406157'), false);
    assert.equal(isValidIsbn('97803X6406157'), false);
    assert.equal(isValidIsbn('97803064061x7'), false);
  });

  test('rejects other non-digit characters', () => {
    assert.equal(isValidIsbn('978030640615.'), false);
    assert.equal(isValidIsbn('978_0306406157'), false);
    assert.equal(isValidIsbn('9780306406157x'), false);
  });

  test('rejects non-string input without throwing', () => {
    assert.equal(isValidIsbn(undefined), false);
    assert.equal(isValidIsbn(null), false);
    assert.equal(isValidIsbn(9780306406157), false);
    assert.equal(isValidIsbn({}), false);
  });

  test('assertIsbn returns the normalized value for valid input', () => {
    assert.equal(assertIsbn('978-0-306-40615-7'), '9780306406157');
    assert.equal(assertIsbn('9780306406157'), '9780306406157');
  });
});

describe('R2 invalid ISBN rejection', () => {
  const rejects = (isbn) => () => createRecord({ isbn, title: 'T', year: 2000 });

  test('createRecord normalizes a valid hyphenated ISBN', () => {
    const rec = createRecord({ isbn: '978-0-306-40615-7', title: 'T', year: 2000 });
    assert.equal(rec.isbn, '9780306406157');
  });

  test('wrong check digit throws InvalidIsbnError with the original input in the message', () => {
    assert.throws(rejects('9780306406158'), {
      name: 'InvalidIsbnError',
      message: 'Invalid ISBN-13: 9780306406158',
    });
  });

  test('the message carries the input unchanged, including hyphens and spaces', () => {
    assert.throws(rejects('978-0-306-40615-8'), {
      name: 'InvalidIsbnError',
      message: 'Invalid ISBN-13: 978-0-306-40615-8',
    });
    assert.throws(rejects(' 978 0306406158 '), {
      name: 'InvalidIsbnError',
      message: 'Invalid ISBN-13:  978 0306406158 ',
    });
  });

  test('wrong length throws', () => {
    assert.throws(rejects('978030640615'), {
      name: 'InvalidIsbnError',
      message: 'Invalid ISBN-13: 978030640615',
    });
    assert.throws(rejects('97803064061570'), {
      name: 'InvalidIsbnError',
      message: 'Invalid ISBN-13: 97803064061570',
    });
  });

  test('empty string throws', () => {
    assert.throws(rejects(''), { name: 'InvalidIsbnError', message: 'Invalid ISBN-13: ' });
  });

  test('the letter X in any position throws', () => {
    for (const bad of ['978030640615X', 'X780306406157', '97803X6406157']) {
      assert.throws(rejects(bad), {
        name: 'InvalidIsbnError',
        message: `Invalid ISBN-13: ${bad}`,
      });
    }
  });

  test('missing ISBN throws InvalidIsbnError', () => {
    assert.throws(() => createRecord({ title: 'T', year: 2000 }), { name: 'InvalidIsbnError' });
  });

  test('the thrown error is an Error and an instance of the exported class', () => {
    try {
      createRecord({ isbn: '9780306406158', title: 'T', year: 2000 });
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err instanceof InvalidIsbnError);
      assert.equal(err.name, 'InvalidIsbnError');
      assert.equal(InvalidIsbnError.name, 'InvalidIsbnError');
    }
  });

  test('assertIsbn throws the same error for invalid input', () => {
    assert.throws(() => assertIsbn('9780306406158'), {
      name: 'InvalidIsbnError',
      message: 'Invalid ISBN-13: 9780306406158',
    });
  });

  test('an invalid ISBN is rejected before the title is considered', () => {
    // Source behavior: ISBN is validated first, so the ISBN error wins over a bad title.
    assert.throws(() => createRecord({ isbn: 'bad', title: '   ', year: 2000 }), {
      name: 'InvalidIsbnError',
    });
  });
});
