import { test, expect } from '@playwright/test';
import { openGallery } from './support/serve.mjs';

test.describe('card rendering (R9, R10)', () => {
  test('a card renders title, "by" line, year and normalized tags in order', async ({ page }) => {
    await openGallery(page);
    const card = page.locator('.card[data-id="p3"]');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-id', 'p3');

    const order = await card.evaluate((el) =>
      [...el.children].map((c) => c.className),
    );
    expect(order.slice(0, 3)).toEqual(['title', 'photographer', 'year']);
    expect(order.indexOf('tags')).toBeGreaterThan(2);

    await expect(card.locator('.title')).toHaveText('Portrait in Wool');
    await expect(card.locator('.photographer')).toHaveText('by Ines Duarte');
    await expect(card.locator('.year')).toHaveText('1938');
    await expect(card.locator('.tag')).toHaveCount(2);
    expect(await card.locator('.tag').allTextContents()).toEqual(['portrait', 'night']);
  });

  test('duplicate raw tags collapse to one element on the first card', async ({ page }) => {
    await openGallery(page);
    const card = page.locator('.card[data-id="p1"]');
    expect(await card.locator('.tag').allTextContents()).toEqual(['harbor', 'night']);
  });

  test('every card carries a unique data-id from the data set', async ({ page }) => {
    await openGallery(page);
    const ids = await page.locator('#grid .card').evaluateAll((els) => els.map((e) => e.dataset.id));
    expect([...ids].sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
    expect(new Set(ids).size).toBe(8);
  });

  test('tag filter buttons are the sorted union of normalized tags', async ({ page }) => {
    await openGallery(page);
    expect(await page.locator('#tags button').allTextContents()).toEqual([
      'architecture',
      'harbor',
      'landscape',
      'market',
      'night',
      'portrait',
      'street',
      'technology',
    ]);
  });

  test('tag buttons all start unpressed', async ({ page }) => {
    await openGallery(page);
    const states = await page
      .locator('#tags button')
      .evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-pressed')));
    expect(states).toEqual(Array(8).fill('false'));
  });
});
