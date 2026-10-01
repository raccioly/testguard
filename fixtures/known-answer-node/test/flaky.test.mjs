import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { value } from '../src/policy.mjs';
test('deliberately flaky baseline', () => {
  const file = '.baseline-counter';
  const next = (existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0) + 1;
  writeFileSync(file, String(next));
  assert.equal(next % 2, 0);
  assert.equal(value(), 1);
});
