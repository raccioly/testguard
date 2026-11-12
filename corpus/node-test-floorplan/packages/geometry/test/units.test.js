import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { convertLength, convertArea, overlaps, UnknownUnit } from '../src/index.js';

describe('R4 convertLength', () => {
  test('10 ft to m is 3.048', () => {
    assert.equal(convertLength(10, 'ft', 'm'), 3.048);
  });

  test('100 cm to in is 39.3701', () => {
    assert.equal(convertLength(100, 'cm', 'in'), 39.3701);
  });

  test('same unit returns the value', () => {
    assert.equal(convertLength(7, 'm', 'm'), 7);
  });

  test('1 in to m is 0.0254', () => {
    assert.equal(convertLength(1, 'in', 'm'), 0.0254);
  });

  test('1 m to cm is 100', () => {
    assert.equal(convertLength(1, 'm', 'cm'), 100);
  });

  test('round trip ft -> m -> ft returns the original', () => {
    const m = convertLength(10, 'ft', 'm');
    assert.equal(convertLength(m, 'm', 'ft'), 10);
  });

  test('round trip in -> cm -> in returns the original', () => {
    const cm = convertLength(12, 'in', 'cm');
    assert.equal(convertLength(cm, 'cm', 'in'), 12);
  });

  test('result is rounded to 4 decimal places', () => {
    assert.equal(convertLength(1, 'm', 'ft'), 3.2808);
  });
});

describe('R5 convertArea', () => {
  test('1 m2 to ft2 is 10.7639', () => {
    assert.equal(convertArea(1, 'm', 'ft'), 10.7639);
  });

  test('uses the squared factor: 1 m2 to cm2 is 10000', () => {
    assert.equal(convertArea(1, 'm', 'cm'), 10000);
  });

  test('same unit returns the value', () => {
    assert.equal(convertArea(5, 'ft', 'ft'), 5);
  });
});

describe('R5 UnknownUnit', () => {
  test('convertLength rejects an unknown source unit with exact message', () => {
    assert.throws(() => convertLength(1, 'yd', 'm'), {
      name: 'UnknownUnit',
      message: 'Unknown unit: yd',
    });
  });

  test('convertLength rejects an unknown target unit with exact message', () => {
    assert.throws(() => convertLength(1, 'm', 'mile'), {
      name: 'UnknownUnit',
      message: 'Unknown unit: mile',
    });
  });

  test('convertArea rejects an unknown unit with exact message', () => {
    assert.throws(() => convertArea(1, 'furlong', 'm'), {
      name: 'UnknownUnit',
      message: 'Unknown unit: furlong',
    });
  });

  test('error is an UnknownUnit instance', () => {
    assert.throws(() => convertLength(1, 'x', 'm'), UnknownUnit);
  });

  test('inherited object keys are not units', () => {
    assert.throws(() => convertLength(1, 'toString', 'm'), {
      name: 'UnknownUnit',
      message: 'Unknown unit: toString',
    });
  });
});

describe('R6 overlaps', () => {
  const A = { x: 0, y: 0, width: 4, height: 4 };

  test('B at (3,0) 2x2 overlaps A', () => {
    assert.equal(overlaps(A, { x: 3, y: 0, width: 2, height: 2 }), true);
  });

  test('edge-touching B at (4,0) 2x2 does not overlap A', () => {
    assert.equal(overlaps(A, { x: 4, y: 0, width: 2, height: 2 }), false);
  });

  test('edge-touching along the top does not overlap', () => {
    assert.equal(overlaps(A, { x: 0, y: 4, width: 2, height: 2 }), false);
  });

  test('corner-touching does not overlap', () => {
    assert.equal(overlaps(A, { x: 4, y: 4, width: 2, height: 2 }), false);
  });

  test('corner-touching at the origin corner does not overlap', () => {
    assert.equal(overlaps(A, { x: -2, y: -2, width: 2, height: 2 }), false);
  });

  test('is symmetric', () => {
    const B = { x: 3, y: 0, width: 2, height: 2 };
    assert.equal(overlaps(B, A), overlaps(A, B));
    const C = { x: 4, y: 0, width: 2, height: 2 };
    assert.equal(overlaps(C, A), overlaps(A, C));
  });

  test('a rectangle contained in another overlaps', () => {
    assert.equal(overlaps(A, { x: 1, y: 1, width: 1, height: 1 }), true);
  });

  test('identical rectangles overlap', () => {
    assert.equal(overlaps(A, { ...A }), true);
  });

  test('far apart rectangles do not overlap', () => {
    assert.equal(overlaps(A, { x: 100, y: 100, width: 2, height: 2 }), false);
  });

  test('separated on one axis only does not overlap', () => {
    assert.equal(overlaps(A, { x: 1, y: 10, width: 2, height: 2 }), false);
  });
});
