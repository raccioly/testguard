// Serves this project's files to the browser at http://gallery.test/ by
// intercepting requests: no server process, no port. Infrastructure written by
// the corpus orchestrator, not by a test author.
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

export async function openGallery(page) {
  await page.route('http://gallery.test/**', async (route) => {
    const path = normalize(new URL(route.request().url()).pathname).replace(/^\/+/, '');
    try {
      const body = await readFile(join(ROOT, path || 'index.html'));
      await route.fulfill({ status: 200, contentType: TYPES[extname(path)] ?? 'application/octet-stream', body });
    } catch {
      await route.fulfill({ status: 404, body: 'not found' });
    }
  });
  await page.goto('http://gallery.test/index.html');
  await page.waitForSelector('#grid .card');
}
