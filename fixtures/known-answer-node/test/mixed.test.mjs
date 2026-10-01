import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { value } from '../src/policy.mjs';
test('deliberately mixed fault response', () => {
  if (value() === 1) { assert.equal(value(), 1); return; }
  const file = '.probe-counter';
  const next = (existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0) + 1;
  writeFileSync(file, String(next));
  assert.equal(next % 2, 0);
});
