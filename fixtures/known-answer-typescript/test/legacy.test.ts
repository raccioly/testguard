import { test, expect } from 'vitest';
import { double } from '../src/legacy.js';

test('double doubles', () => {
  expect(double(4)).toBe(8);
});
