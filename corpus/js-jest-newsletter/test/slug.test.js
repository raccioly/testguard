const { slugify } = require('../src/slug');

describe('slugify smoke calls', () => {
  test('plain titles', () => {
    slugify('Hello World');
    slugify('Quillbird Weekly Issue 12');
  });

  test('punctuation', () => {
    slugify('Hello, World! 2024');
    slugify('--Already -- hyphenated--');
  });

  test('accented', () => {
    slugify('Café Crème');
    slugify('Ñandú über straße');
  });

  test('very long', () => {
    slugify('word '.repeat(100));
    slugify('x'.repeat(200));
  });

  test('explicit limits', () => {
    slugify('alpha beta gamma', 11);
    slugify('alpha beta gamma', 1);
    slugify('alpha beta gamma', 100);
  });
});
