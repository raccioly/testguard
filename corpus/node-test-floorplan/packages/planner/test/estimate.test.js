import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LShape } from '@floorplan/geometry';
import { estimateFlooring } from '../src/index.js';

describe('R10 estimateFlooring', () => {
  test('20 m2 of tile yields 22.0', () => {
    assert.equal(estimateFlooring(20, 'tile'), 22);
  });

  test('20 m2 of carpet yields 21.0', () => {
    assert.equal(estimateFlooring(20, 'carpet'), 21);
  });

  test('10.2 m2 of tile yields 11.5 (11.22 rounded up)', () => {
    assert.equal(estimateFlooring(10.2, 'tile'), 11.5);
  });

  test('rounds up to the next 0.5, never down', () => {
    assert.equal(estimateFlooring(10, 'carpet'), 10.5);
    assert.equal(estimateFlooring(1, 'tile'), 1.5);
  });

  test('tile waste is larger than carpet waste for the same area', () => {
    assert.ok(estimateFlooring(100, 'tile') > estimateFlooring(100, 'carpet'));
    assert.equal(estimateFlooring(100, 'tile'), 110);
    assert.equal(estimateFlooring(100, 'carpet'), 105);
  });
});

describe('R11 estimateFlooring errors', () => {
  test('unknown material is rejected with UnknownMaterial and exact message', () => {
    assert.throws(() => estimateFlooring(10, 'marble'), {
      name: 'UnknownMaterial',
      message: 'Unknown material: marble',
    });
  });

  test('inherited object keys are not materials', () => {
    assert.throws(() => estimateFlooring(10, 'toString'), {
      name: 'UnknownMaterial',
      message: 'Unknown material: toString',
    });
  });

  test('zero area is rejected with InvalidDimension', () => {
    assert.throws(() => estimateFlooring(0, 'tile'), { name: 'InvalidDimension' });
  });

  test('negative area is rejected with InvalidDimension', () => {
    assert.throws(() => estimateFlooring(-5, 'carpet'), { name: 'InvalidDimension' });
  });
});

describe('R12 L-shaped room estimate', () => {
  test('L-shape outer 10x8 notch 4x3 in carpet yields 71.5', () => {
    const l = new LShape(10, 8, 4, 3);
    assert.equal(l.area, 68);
    assert.equal(estimateFlooring(l.area, 'carpet'), 71.5);
  });

  test('the shape itself can be passed and uses its area', () => {
    const l = new LShape(10, 8, 4, 3);
    assert.equal(estimateFlooring(l, 'carpet'), 71.5);
  });

  test('L-shape in tile yields 75.0 (74.8 rounded up)', () => {
    const l = new LShape(10, 8, 4, 3);
    assert.equal(estimateFlooring(l.area, 'tile'), 75);
  });
});
