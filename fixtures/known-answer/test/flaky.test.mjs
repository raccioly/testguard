import { it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';

// Deterministically flaky: fails on odd-numbered runs, passes on even ones,
// using a counter file next to the fixture. Any three consecutive runs
// therefore contain at least one failure, which is the `flaky-defender` case.
const counterFile = new URL('../.flake-counter', import.meta.url);

it('is flaky by design (fails every other run)', () => {
  let n = 0;
  try {
    n = Number(readFileSync(counterFile, 'utf8')) || 0;
  } catch {}
  n += 1;
  writeFileSync(counterFile, String(n));
  expect(n % 2).toBe(0);
});
