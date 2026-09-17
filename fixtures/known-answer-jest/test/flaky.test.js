const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

// Deterministically flaky: fails on odd-numbered runs (the `flaky-defender` case).
const counterFile = path.join(__dirname, '..', '.flake-counter');

it('is flaky by design (fails every other run)', () => {
  let n = 0;
  try { n = Number(readFileSync(counterFile, 'utf8')) || 0; } catch {}
  n += 1;
  writeFileSync(counterFile, String(n));
  expect(n % 2).toBe(0);
});
