import { describe, it, expect } from 'vitest';
import { legacyRate } from '../src/legacy-rates.js';

describe('legacyRate', () => {
  it('returns 1800 for members', () => {
    expect(legacyRate('member')).toBe(1800);
  });
});
