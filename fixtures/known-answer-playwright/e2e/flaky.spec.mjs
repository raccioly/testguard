import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Fails on every odd attempt, using a counter file beside the fixture. With
// retries: 1 the first attempt fails and the retry passes, so Playwright
// reports the test as `flaky` and exits 0. A green exit code is exactly what
// a flaky defender looks like; the adapter must not call that run green.
const COUNTER = fileURLToPath(new URL('../.flake-counter', import.meta.url));
test('is flaky by design', () => {
  let n = 0;
  try { n = Number(readFileSync(COUNTER, 'utf8')) || 0; } catch {}
  n += 1;
  writeFileSync(COUNTER, String(n));
  expect(n % 2, `attempt ${n} is odd and fails on purpose`).toBe(0);
});
