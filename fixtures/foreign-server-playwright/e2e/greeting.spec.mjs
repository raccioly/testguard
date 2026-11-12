import { test, expect } from '@playwright/test';

// No browser: the `request` fixture talks to the server the config starts.
test('the server greets', async ({ request }) => {
  const response = await request.get('/');
  expect(await response.text()).toBe('hello');
});
