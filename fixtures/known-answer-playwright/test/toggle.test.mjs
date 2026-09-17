import { it, expect } from 'vitest';
import { renderToggle } from '../src/toggle.mjs';

// THE BLIND SPOT: this unit test checks the label text and never the input.
// A row whose toggle vanished, or lost its handler, still passes here.
it('renders the greeting row', () => {
  const html = renderToggle({ on: true });
  expect(typeof html).toBe('string');
  expect(html).toContain('Send a greeting');
});
