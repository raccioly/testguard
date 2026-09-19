#!/usr/bin/env node
/**
 * Render docs/testguard-explained.html to PDF with headless Chrome.
 *
 * Chrome rather than a library because this repository has one pinned runtime
 * dependency and keeps it that way: a PDF renderer would be the second, and it
 * would be needed only to build a document nobody imports.
 *
 * Set CHROME to override the binary.
 *
 *   (no flags)        render; exit 0 with a notice when no Chrome is present,
 *                     so a checkout without one can still run every other
 *                     script.
 *   --require-chrome  a missing Chrome is a failure. The release uses this:
 *                     there, "skipped the render" means shipping a PDF that
 *                     disagrees with the HTML beside it, which is the exact
 *                     drift this script exists to prevent — and it would pass
 *                     silently, which is worse than failing.
 *
 * After a successful render the page count is checked against the number of
 * `.page` divs in the source. That is not a nicety: `.page` sets
 * `min-height: 279.4mm` and `page-break-after: always`, which is a request,
 * not a constraint. A section a few pixels too tall spills onto a second
 * physical sheet with no warning from Chrome, renumbering nothing and
 * contradicting the "Page N of M" footers the document prints itself. It
 * happened while updating the brief for 0.8.1 and cost two extra pages.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = join(root, 'docs', 'testguard-explained.html');
const out = join(root, 'docs', 'testguard-explained.pdf');
const requireChrome = process.argv.slice(2).includes('--require-chrome');

// CHROME overrides rather than merely leads: a binary named explicitly and not
// found is a mistake worth hearing about, not a reason to quietly render with
// some other browser the machine happens to have.
const candidates = process.env.CHROME ? [process.env.CHROME] : [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const chrome = candidates.find((c) => existsSync(c));
if (!chrome) {
  const how = process.env.CHROME
    ? `CHROME=${process.env.CHROME} does not exist`
    : 'set CHROME=<path> to force';
  if (requireChrome) {
    console.error(`no Chrome found and --require-chrome was given; refusing to leave a stale PDF (${how})`);
    process.exit(1);
  }
  console.log(`no Chrome found; skipping PDF build (${how})`);
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

/** The sheets Chrome actually produced. `/Type /Pages` is the tree node, not a sheet. */
const sheets = (readFileSync(out).toString('latin1').match(/\/Type\s*\/Page(?![s/\w])/g) ?? []).length;
/** The sheets the document intends: one `.page` div each. */
const intended = (readFileSync(src, 'utf8').match(/<div class="page"[\s>]/g) ?? []).length;

if (intended === 0) {
  console.error('docs/testguard-explained.html: no `.page` divs found — the page-count guard cannot run');
  process.exit(1);
}
if (sheets !== intended) {
  console.error(
    `docs/testguard-explained.pdf: ${sheets} sheets rendered from ${intended} \`.page\` divs.\n` +
    'A .page taller than its sheet spills silently. Letter at margin 0 is 816x1056 CSS px: load the\n' +
    'HTML at that viewport and look for a .page whose getBoundingClientRect().height exceeds 1056.\n' +
    'Measuring at any other width is meaningless, because the text reflows.',
  );
  process.exit(1);
}

console.log(`docs/testguard-explained.pdf written with ${chrome.split('/').pop()} — ${sheets} pages, one per .page div`);
