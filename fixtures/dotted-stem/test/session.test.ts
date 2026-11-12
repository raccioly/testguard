import { expect, it } from 'vitest';
import { expiresAt } from '../src/session';

it('a session lasts an hour', () => {
  expect(expiresAt(0)).toBe(3600);
});
