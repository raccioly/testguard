#!/usr/bin/env node
/**
 * Render docs/testguard-explained.html to PDF with headless Chrome.
 *
 * Chrome rather than a library because this repository has one pinned runtime
 * dependency and keeps it that way: a PDF renderer would be the second, and it
 * would be needed only to build a document nobody imports.
 *
 * Set CHROME to override the binary. Exits 0 with a notice when no Chrome is
 * present, so a checkout without one can still run every other script.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = join(root, 'docs', 'testguard-explained.html');
const out = join(root, 'docs', 'testguard-explained.pdf');

const candidates = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const chrome = candidates.find((c) => existsSync(c));
if (!chrome) {
  console.log('no Chrome found; skipping PDF build (set CHROME=<path> to force)');
  process.exit(0);
}

const r = spawnSync(chrome, [
  '--headless',
  '--disable-gpu',
  '--no-sandbox',
  '--no-pdf-header-footer',
  `--print-to-pdf=${out}`,
  `file://${src}`,
], { encoding: 'utf8' });

if (r.status !== 0 || !existsSync(out)) {
  console.error(r.stderr || 'chrome produced no PDF');
  process.exit(1);
}
console.log(`docs/testguard-explained.pdf written with ${chrome.split('/').pop()}`);
