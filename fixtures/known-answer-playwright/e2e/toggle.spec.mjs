import { test, expect } from '@playwright/test';
import { renderToggle } from '../src/toggle.mjs';

// Browserless Playwright specs: they assert on the rendered markup directly.
// With `page.setContent(renderToggle(...))` and `getByTestId` they would
// assert the same thing through a browser; the adapter does not care which.
test('the greeting toggle is a visible checkbox', async () => {
  const html = await renderToggle({ on: true }); // await: a render that never settles is a clean Playwright timeout, not a hung worker
  expect(html).toContain('type="checkbox"');
  expect(html).toContain('data-testid="greeting-toggle"');
  expect(html).toContain(' checked');
});

test('the toggle carries its change handler', async () => {
  expect(await renderToggle({ handler: 'save' })).toContain('onchange="save(this.checked)"');
});
