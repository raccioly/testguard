import { test, expect } from 'vitest';
import { applyDiscount, label } from '../src/price';

test('a 25 percent discount takes a quarter off', () => {
  expect(applyDiscount(1000, 25)).toBe(750);
});

test('a label starts with a dollar sign', () => {
  expect(label(1234).startsWith('$')).toBe(true);
});
