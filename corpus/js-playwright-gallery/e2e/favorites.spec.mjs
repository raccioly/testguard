import { test } from '@playwright/test';
import { openGallery } from './support/serve.mjs';

test('clicks favorite buttons on several cards', async ({ page }) => {
  await openGallery(page);
  const fav = (id) => page.locator(`.card[data-id="${id}"] button.fav`);
  await fav('p1').click();
  await fav('p3').click();
  await fav('p3').click();
  await fav('p5').click();
  await fav('p8').click();
  await fav('p8').click();
  await fav('p8').click();
});
