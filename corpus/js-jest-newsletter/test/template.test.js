const { render } = require('../src/template');

function catchError(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected function to throw');
}

describe('R1 substitution', () => {
  test('replaces a placeholder', () => {
    expect(render('Hi {{who}}!', { who: 'Ann' })).toBe('Hi Ann!');
  });

  test('inner spaces are equivalent', () => {
    expect(render('Hi {{ who }}!', { who: 'Ann' })).toBe('Hi Ann!');
    expect(render('Hi {{   who}}!', { who: 'Ann' })).toBe('Hi Ann!');
    expect(render('Hi {{who  }}!', { who: 'Ann' })).toBe('Hi Ann!');
  });

  test('replaces every occurrence and several names, digits and underscores allowed', () => {
    expect(render('{{a_1}}-{{b2}}-{{a_1}}', { a_1: 'x', b2: 'y' })).toBe('x-y-x');
  });

  test('text outside placeholders is copied unchanged', () => {
    expect(render('  plain\ntext  ', {})).toBe('  plain\ntext  ');
    expect(render('', {})).toBe('');
  });
});

describe('R2 escaping', () => {
  test.each([
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&#39;'],
  ])('escapes %s', (ch, escaped) => {
    expect(render('{{x}}', { x: ch })).toBe(escaped);
  });

  test('spec example for escaped form', () => {
    expect(render('{{x}}', { x: '<b>&' })).toBe('&lt;b&gt;&amp;');
  });

  test('triple-brace form inserts raw value', () => {
    expect(render('{{{x}}}', { x: '<b>&' })).toBe('<b>&');
    expect(render('{{{ x }}}', { x: '"\'' })).toBe('"\'');
  });

  test('ampersand is escaped once, not double escaped', () => {
    expect(render('{{x}}', { x: '&lt;' })).toBe('&amp;lt;');
  });
});

describe('R3 missing values', () => {
  test('strict mode (default) throws MissingValueError with exact message', () => {
    const e = catchError(() => render('Hi {{who}}', {}));
    expect(e.name).toBe('MissingValueError');
    expect(e.message).toBe('missing value: who');
  });

  test('strict mode also applies to raw form', () => {
    const e = catchError(() => render('{{{who}}}', {}));
    expect(e.name).toBe('MissingValueError');
    expect(e.message).toBe('missing value: who');
  });

  test('lenient mode replaces with empty string', () => {
    expect(render('Hi {{who}}!', {}, { lenient: true })).toBe('Hi !');
    expect(render('Hi {{{who}}}!', {}, { mode: 'lenient' })).toBe('Hi !');
  });

  test('empty-string value is not missing', () => {
    expect(render('[{{a}}]', { a: '' })).toBe('[]');
  });
});

describe('R4 no re-scanning and syntax errors', () => {
  test('values are not re-scanned', () => {
    expect(render('{{a}}', { a: '{{b}}', b: 'no' })).toBe('{{b}}');
    expect(render('{{{a}}}', { a: '{{b}}', b: 'no' })).toBe('{{b}}');
  });

  test('unclosed placeholder reports zero-based position', () => {
    const e = catchError(() => render('Hi {{who', { who: 'x' }));
    expect(e.name).toBe('TemplateSyntaxError');
    expect(e.message).toBe('unclosed placeholder at position 3');
  });

  test('position refers to the opening braces of the unclosed one', () => {
    const e = catchError(() => render('a {{x}} {{y', { x: '1', y: '2' }));
    expect(e.name).toBe('TemplateSyntaxError');
    expect(e.message).toBe('unclosed placeholder at position 8');
  });

  test('unclosed at position 0', () => {
    const e = catchError(() => render('{{', {}));
    expect(e.name).toBe('TemplateSyntaxError');
    expect(e.message).toBe('unclosed placeholder at position 0');
  });

  test('unclosed raw placeholder', () => {
    const e = catchError(() => render('ab {{{x}}', { x: '1' }));
    expect(e.name).toBe('TemplateSyntaxError');
    expect(e.message).toBe('unclosed placeholder at position 3');
  });
});
