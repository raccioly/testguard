import { expect, it } from 'vitest';
import { isAdult } from '../../src/age.mjs';

it('18 is the first adult age', () => {
  expect(isAdult(18)).toBe(true);
  expect(isAdult(17)).toBe(false);
});
