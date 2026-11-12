import { test, expect } from '@playwright/test';
import { openGallery } from './support/serve.mjs';

test('clicking a tag button marks it pressed', async ({ page }) => {
  await openGallery(page);
  const button = page.locator('#tags button[data-tag="harbor"]');
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
});
