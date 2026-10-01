import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowed, audit, ready } from '../src/policy.mjs';
test('only the public kind is allowed', () => {
  assert.equal(allowed('public'), true);
  assert.equal(allowed('private'), false);
});
test('the audit row has its kind', () => {
  assert.equal(audit({ kind: 'public', content: 'private payload' }).kind, 'public');
});
test('readiness resolves', { timeout: 100 }, async (t) => {
  const hold = setInterval(() => {}, 1000);
  t.signal.addEventListener('abort', () => clearInterval(hold), { once: true });
  try { assert.equal(await ready(), true); } finally { clearInterval(hold); }
});
