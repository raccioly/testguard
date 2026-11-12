import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Rectangle, LShape, InvalidDimension } from '../src/index.js';

const BAD = [
  ['zero', 0],
  ['negative', -1],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
];

describe('R1 Rectangle', () => {
  test('4 x 2.5 has area 10 and perimeter 13', () => {
    const r = new Rectangle(4, 2.5);
    assert.equal(r.area, 10);
    assert.equal(r.perimeter, 13);
  });

  test('exposes width and height', () => {
    const r = new Rectangle(3, 7);
    assert.equal(r.width, 3);
    assert.equal(r.height, 7);
    assert.equal(r.area, 21);
    assert.equal(r.perimeter, 20);
  });

  for (const [label, bad] of BAD) {
    test(`rejects ${label} width`, () => {
      assert.throws(() => new Rectangle(bad, 2), { name: 'InvalidDimension' });
    });
    test(`rejects ${label} height`, () => {
      assert.throws(() => new Rectangle(2, bad), { name: 'InvalidDimension' });
    });
  }

  test('thrown error is an InvalidDimension instance', () => {
    assert.throws(() => new Rectangle(0, 1), InvalidDimension);
  });
});

describe('R2 LShape', () => {
  test('outer 10x8 notch 4x3 has area 68 and perimeter 36', () => {
    const l = new LShape(10, 8, 4, 3);
    assert.equal(l.area, 68);
    assert.equal(l.perimeter, 36);
  });

  test('perimeter ignores the notch size', () => {
    assert.equal(new LShape(10, 8, 1, 1).perimeter, 36);
    assert.equal(new LShape(10, 8, 9, 7).perimeter, 36);
  });

  test('area subtracts notch area from the outer rectangle', () => {
    assert.equal(new LShape(5, 5, 2, 2).area, 21);
  });
});

describe('R3 LShape and shape validation', () => {
  for (const [label, bad] of BAD) {
    test(`LShape rejects ${label} outer width`, () => {
      assert.throws(() => new LShape(bad, 8, 4, 3), { name: 'InvalidDimension' });
    });
    test(`LShape rejects ${label} outer height`, () => {
      assert.throws(() => new LShape(10, bad, 4, 3), { name: 'InvalidDimension' });
    });
    test(`LShape rejects ${label} notch width`, () => {
      assert.throws(() => new LShape(10, 8, bad, 3), { name: 'InvalidDimension' });
    });
    test(`LShape rejects ${label} notch height`, () => {
      assert.throws(() => new LShape(10, 8, 4, bad), { name: 'InvalidDimension' });
    });
  }

  test('rejects notch width equal to outer width', () => {
    assert.throws(() => new LShape(10, 8, 10, 3), { name: 'InvalidDimension' });
  });

  test('rejects notch width greater than outer width', () => {
    assert.throws(() => new LShape(10, 8, 11, 3), { name: 'InvalidDimension' });
  });

  test('rejects notch height equal to outer height', () => {
    assert.throws(() => new LShape(10, 8, 4, 8), { name: 'InvalidDimension' });
  });

  test('rejects notch height greater than outer height', () => {
    assert.throws(() => new LShape(10, 8, 4, 9), { name: 'InvalidDimension' });
  });

  test('accepts a notch just under the outer size', () => {
    const l = new LShape(10, 8, 9.99, 7.99);
    assert.ok(l.area > 0);
  });
});
