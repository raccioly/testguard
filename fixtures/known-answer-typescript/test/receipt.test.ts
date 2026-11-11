import { test, expect } from 'vitest';
import { line, total } from '../src/receipt';

test('total adds tax to the subtotal', () => {
  expect(total(1000, 80)).toBe(1080);
});

test('a line shows the total as dollars', () => {
  expect(line(1000, 80)).toBe('$10.80');
});
