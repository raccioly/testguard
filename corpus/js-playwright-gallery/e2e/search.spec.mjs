import { test, expect } from '@playwright/test';
import { openGallery } from './support/serve.mjs';

const titles = (page) => page.locator('#grid .card .title').allTextContents();

test.describe('search (R1, R3)', () => {
  test('initial state shows every card and the full status line', async ({ page }) => {
    await openGallery(page);
    await expect(page.locator('#status')).toHaveText('Showing 8 of 8 photos');
    await expect(page.locator('#grid .card')).toHaveCount(8);
    await expect(page.locator('#empty')).toBeHidden();
  });

  test('query with surrounding spaces is trimmed', async ({ page }) => {
    await openGallery(page);
    await page.locator('#search').fill('  harbor ');
    expect(await titles(page)).toEqual(['Old Harbor Light']);
    await expect(page.locator('#status')).toHaveText('Showing 1 of 8 photos');
    await expect(page.locator('#empty')).toBeHidden();
  });

  test('search is case-insensitive', async ({ page }) => {
    await openGallery(page);
    await page.locator('#search').fill('HARBOR');
    expect(await titles(page)).toEqual(['Old Harbor Light']);
    await page.locator('#search').fill('hArBoR');
    expect(await titles(page)).toEqual(['Old Harbor Light']);
    await expect(page.locator('#status')).toHaveText('Showing 1 of 8 photos');
  });

  test('search matches the photographer', async ({ page }) => {
    await openGallery(page);
    await page.locator('#search').fill('mara');
    expect(await titles(page)).toEqual(['Fog Over the Quay', 'Old Harbor Light']);
    await expect(page.locator('#status')).toHaveText('Showing 2 of 8 photos');

    await page.locator('#search').fill('  INES  ');
    expect(await titles(page)).toEqual(['Portrait in Wool', 'Quiet Classroom']);
    await expect(page.locator('#status')).toHaveText('Showing 2 of 8 photos');
  });

  test('search matches a substring in the middle of a title', async ({ page }) => {
    await openGallery(page);
    await page.locator('#search').fill('rain');
    expect(await titles(page)).toEqual(['Neon Rain']);
    await expect(page.locator('#status')).toHaveText('Showing 1 of 8 photos');
  });

  test('whitespace-only and cleared queries match every card', async ({ page }) => {
    await openGallery(page);
    await page.locator('#search').fill('   ');
    await expect(page.locator('#grid .card')).toHaveCount(8);
    await expect(page.locator('#status')).toHaveText('Showing 8 of 8 photos');
    await expect(page.locator('#empty')).toBeHidden();

    await page.locator('#search').fill('harbor');
    await expect(page.locator('#grid .card')).toHaveCount(1);
    await page.locator('#search').fill('');
    await expect(page.locator('#grid .card')).toHaveCount(8);
    await expect(page.locator('#status')).toHaveText('Showing 8 of 8 photos');
  });

  test('no match shows the empty state and "Showing 0 of 8 photos"', async ({ page }) => {
    await openGallery(page);
    await page.locator('#search').fill('zzz-no-such-photo');
    await expect(page.locator('#status')).toHaveText('Showing 0 of 8 photos');
    await expect(page.locator('#empty')).toBeVisible();
    await expect(page.locator('#empty')).toHaveText('No photos match your filters.');
    await expect(page.locator('#grid .card')).toHaveCount(0);
  });

  test('empty state disappears when the query is cleared', async ({ page }) => {
    await openGallery(page);
    await page.locator('#search').fill('zzz');
    await expect(page.locator('#empty')).toBeVisible();
    await page.locator('#search').fill('');
    await expect(page.locator('#empty')).toBeHidden();
    await expect(page.locator('#status')).toHaveText('Showing 8 of 8 photos');
    await expect(page.locator('#grid .card')).toHaveCount(8);
  });
});
