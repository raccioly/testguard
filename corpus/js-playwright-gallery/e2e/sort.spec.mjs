import { test, expect } from '@playwright/test';
import { openGallery } from './support/serve.mjs';
import { sortCards, SORT_KEYS } from '../src/sort.js';

const titles = (page) => page.locator('#grid .card .title').allTextContents();

const BY_TITLE = [
  'Fog Over the Quay',
  'Market Morning',
  'Neon Rain',
  'Old Harbor Light',
  'Portrait in Wool',
  'Quiet Classroom',
  'Solar Field',
  'Steel Bridge',
];
const BY_YEAR = [
  'Solar Field',
  'Quiet Classroom',
  'Neon Rain',
  'Fog Over the Quay',
  'Steel Bridge',
  'Portrait in Wool',
  'Market Morning',
  'Old Harbor Light',
];

async function errorOf(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

test.describe('sort in the browser (R4)', () => {
  test('default sort is title ascending', async ({ page }) => {
    await openGallery(page);
    await expect(page.locator('#sort')).toHaveValue('title');
    expect(await titles(page)).toEqual(BY_TITLE);
  });

  test('sort control offers exactly year and title', async ({ page }) => {
    await openGallery(page);
    const values = await page.locator('#sort option').evaluateAll((os) => os.map((o) => o.value));
    expect([...values].sort()).toEqual(['title', 'year']);
  });

  test('sorting by year shows newest first', async ({ page }) => {
    await openGallery(page);
    await page.locator('#sort').selectOption('year');
    expect(await titles(page)).toEqual(BY_YEAR);
  });

  test('switching back to title restores the title order', async ({ page }) => {
    await openGallery(page);
    await page.locator('#sort').selectOption('year');
    await page.locator('#sort').selectOption('title');
    expect(await titles(page)).toEqual(BY_TITLE);
  });

  test('sorting never changes the set of cards', async ({ page }) => {
    await openGallery(page);
    await page.locator('#sort').selectOption('year');
    await expect(page.locator('#grid .card')).toHaveCount(8);
    await expect(page.locator('#status')).toHaveText('Showing 8 of 8 photos');
    expect([...(await titles(page))].sort()).toEqual([...BY_TITLE].sort());
  });

  test('sort applies after the search filter', async ({ page }) => {
    await openGallery(page);
    await page.locator('#search').fill('mara');
    await page.locator('#sort').selectOption('year');
    expect(await titles(page)).toEqual(['Fog Over the Quay', 'Old Harbor Light']);
    await page.locator('#search').fill('ines');
    expect(await titles(page)).toEqual(['Quiet Classroom', 'Portrait in Wool']);
  });
});

test.describe('sortCards (R4, R5)', () => {
  const a = { id: 'a', title: 'alpha', year: 2000 };
  const A = { id: 'b', title: 'Alpha', year: 1990 };
  const b = { id: 'c', title: 'beta', year: 2000 };

  test('SORT_KEYS lists the two keys', () => {
    expect([...SORT_KEYS].sort()).toEqual(['title', 'year']);
  });

  test('title sort is case-insensitive with year ascending tie-break', () => {
    expect(sortCards([b, a, A], 'title').map((c) => c.id)).toEqual(['b', 'a', 'c']);
  });

  test('year sort is descending with case-insensitive title tie-break', () => {
    const x = { id: 'x', title: 'b', year: 1950 };
    const y = { id: 'y', title: 'A', year: 1950 };
    const z = { id: 'z', title: 'c', year: 1960 };
    expect(sortCards([x, y, z], 'year').map((c) => c.id)).toEqual(['z', 'y', 'x']);
  });

  test('unknown key throws InvalidSortKey with the exact message', async () => {
    const err = await errorOf(() => sortCards([a], 'date'));
    expect(err).not.toBeNull();
    expect(err.name).toBe('InvalidSortKey');
    expect(err.message).toBe('Unknown sort key: date');
  });

  test('an inherited property name is also rejected', async () => {
    const err = await errorOf(() => sortCards([a], 'toString'));
    expect(err.name).toBe('InvalidSortKey');
    expect(err.message).toBe('Unknown sort key: toString');
  });

  test('the key is validated even for an empty list', async () => {
    const err = await errorOf(() => sortCards([], 'nope'));
    expect(err.name).toBe('InvalidSortKey');
    expect(err.message).toBe('Unknown sort key: nope');
  });

  test('does not mutate the input list', () => {
    const input = [b, a, A];
    const snapshot = [...input];
    const out = sortCards(input, 'title');
    expect(input).toEqual(snapshot);
    expect(input[0]).toBe(b);
    expect(out).not.toBe(input);
    sortCards(input, 'year');
    expect(input).toEqual(snapshot);
  });

  test('empty list returns an empty list', () => {
    expect(sortCards([], 'title')).toEqual([]);
    expect(sortCards([], 'year')).toEqual([]);
  });
});
