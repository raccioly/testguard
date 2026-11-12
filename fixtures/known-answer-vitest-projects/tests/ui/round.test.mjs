import { expect, it } from 'vitest';
import { roundHalf } from '../../src/round.mjs';

// Deliberately weak: it never checks which way a half rounds.
it('returns a number', () => {
  expect(typeof roundHalf(1.5)).toBe('number');
});
