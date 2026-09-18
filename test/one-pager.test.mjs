import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, '.github', 'scripts', 'build-one-pager.mjs');
const HTML = join(ROOT, 'docs', 'testguard-explained.html');
const PDF = join(ROOT, 'docs', 'testguard-explained.pdf');

/** How many sheets the brief intends — the same count the script derives. */
const intended = () => (readFileSync(HTML, 'utf8').match(/<div class="page"[\s>]/g) ?? []).length;

/**
 * A stand-in for Chrome that writes a PDF with exactly `sheets` page objects.
 *
 * The bytes are not a real document and do not need to be: the guard counts
 * `/Type /Page` markers, so a stub pins the guard's behaviour without putting
 * a browser — or twenty seconds of rendering — in the unit suite. The real
 * render is exercised by the release, which runs the script for effect.
 */
function stubChrome(sheets) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-one-pager-'));
  const bin = join(dir, 'chrome');
  writeFileSync(bin, [
    '#!/bin/sh',
    'for arg in "$@"; do',
    '  case "$arg" in --print-to-pdf=*) out="${arg#--print-to-pdf=}";; esac',
    'done',
    '[ -n "$out" ] || exit 3',
    `printf '%%PDF-1.4\\n' > "$out"`,
    `i=0; while [ $i -lt ${sheets} ]; do printf '/Type /Page\\n' >> "$out"; i=$((i+1)); done`,
    `printf '/Type /Pages\\n%%%%EOF\\n' >> "$out"`,
    '',
  ].join('\n'));
  chmodSync(bin, 0o755);
  return bin;
}

const run = (env, ...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

describe('build-one-pager: the brief\'s PDF is rendered, never hand-maintained', () => {
  it('a missing Chrome is a notice by default and a failure under --require-chrome', () => {
    const absent = { CHROME: '/nonexistent/chrome' };
    // Default: a checkout without a browser still runs every other script.
    const soft = run(absent);
    expect(soft.status).toBe(0);
    expect(soft.stdout).toContain('skipping PDF build');

    // Release: skipping would ship a PDF that disagrees with the HTML beside
    // it, at exit 0. That silence is the whole bug, so the flag must break.
    const hard = run(absent, '--require-chrome');
    expect(hard.status).toBe(1);
    expect(hard.stderr).toContain('refusing to leave a stale PDF');
    expect(hard.stderr, 'the message should name the binary that was tried').toContain('/nonexistent/chrome');
  });

  it('CHROME overrides the search instead of leading it', () => {
    // If CHROME merely came first, a bad value would silently fall through to
    // a browser the machine happens to have and the run would "succeed".
    expect(run({ CHROME: '/nonexistent/chrome' }, '--require-chrome').status).toBe(1);
  });

  it('a page that spills onto a second sheet fails the build instead of shipping', () => {
    const before = readFileSync(PDF);
    try {
      const over = run({ CHROME: stubChrome(intended() + 1) });
      expect(over.status, over.stdout).toBe(1);
      expect(over.stderr).toContain(`${intended() + 1} sheets rendered from ${intended()}`);
      expect(over.stderr, 'the message should say how to find the tall page').toContain('816x1056');
    } finally {
      writeFileSync(PDF, before); // the stub overwrote the committed artifact
    }
  });

  it('one sheet per .page div is the passing case', () => {
    const before = readFileSync(PDF);
    try {
      const ok = run({ CHROME: stubChrome(intended()) });
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toContain(`${intended()} pages, one per .page div`);
    } finally {
      writeFileSync(PDF, before);
    }
  });
});
