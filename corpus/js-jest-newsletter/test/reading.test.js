const { countWords, readingTime } = require('../src/reading');

function catchError(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected function to throw');
}

describe('R8 countWords', () => {
  test('spec example', () => {
    expect(countWords('  one  two\nthree ')).toBe(3);
  });

  test('empty and whitespace-only text return 0', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords(' \n\t ')).toBe(0);
  });

  test('single word and tab separated words', () => {
    expect(countWords('one')).toBe(1);
    expect(countWords('a\tb\tc')).toBe(3);
  });

  test('punctuation stays attached to words', () => {
    expect(countWords('well-known, yes!')).toBe(2);
  });
});

describe('R9 readingTime boundaries', () => {
  test.each([
    [0, 'skimmer', 0],
    [1, 'skimmer', 1],
    [200, 'skimmer', 1],
    [201, 'skimmer', 1],
    [400, 'skimmer', 1],
    [401, 'skimmer', 2],
    [800, 'skimmer', 2],
    [801, 'skimmer', 3],
  ])('%i words as %s -> %i', (count, reader, expected) => {
    expect(readingTime(count, reader)).toBe(expected);
  });

  test.each([
    [0, 'careful', 0],
    [1, 'careful', 1],
    [200, 'careful', 1],
    [201, 'careful', 2],
    [400, 'careful', 2],
    [401, 'careful', 3],
  ])('%i words as %s -> %i', (count, reader, expected) => {
    expect(readingTime(count, reader)).toBe(expected);
  });
});

describe('R10 errors', () => {
  test.each([[-1], [1.5], [NaN], ['3']])('invalid count %p', (count) => {
    const e = catchError(() => readingTime(count, 'skimmer'));
    expect(e.name).toBe('InvalidCountError');
    expect(e.message).toBe('count must be a non-negative integer');
  });

  test('unknown reader class', () => {
    const e = catchError(() => readingTime(10, 'speedy'));
    expect(e.name).toBe('UnknownReaderError');
    expect(e.message).toBe('unknown reader: speedy');
  });
});
