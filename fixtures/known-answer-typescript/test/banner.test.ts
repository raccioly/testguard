import { test, expect } from 'vitest';
import { banner } from '../tools/banner';

test('a banner frames the name', () => {
  expect(banner('app')).toBe('== app ==');
});
