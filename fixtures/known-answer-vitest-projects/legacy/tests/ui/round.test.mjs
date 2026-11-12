import { expect, it } from 'vitest';
import { roundHalf } from '../../../src/round.mjs';

// The legacy project's test. Its path contains tests/ui/round.test.mjs, so a
// run that filters by that path alone runs this file too.
it('rounds a half up', () => {
  expect(roundHalf(1.5)).toBe(2);
});
