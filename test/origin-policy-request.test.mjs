import { expect, it } from 'vitest';
import { originPolicyRequest } from '../src/probe/origin-policy.mjs';

it('leaves absent policy absent on every command without changing old options', () => {
  for (const command of ['probe', 'status', 'claims', 'gate', 'brief', 'baseline']) {
    expect(originPolicyRequest({ claim: ['C-1'], confirm: '1', ref: 'HEAD', 'allow-empty': true }, command)).toBeUndefined();
  }
});
it('normalizes repeated comma selections without assigning strength or modifying input', () => {
  const values = { 'require-origin': [' spec, bug ', 'manual,inferred,spec'], confirm: '3', 'include-dirty': true };
  const before = JSON.stringify(values);
  expect(originPolicyRequest(values)).toEqual(['bug', 'inferred', 'manual', 'spec']);
  expect(JSON.stringify(values)).toBe(before);
});
it.each([[], [''], [','], ['spec,'], [',spec'], ['spec,,bug'], ['Spec'], ['authenticated'], ['spec', ''], 'spec', [1]].map((raw) => ({ raw })))('refuses malformed selection %j rather than dropping tokens', ({ raw }) => {
  expect(() => originPolicyRequest({ 'require-origin': raw })).toThrow(TypeError);
});
it.each(['claims', 'status', 'brief', 'gate', 'baseline', 'scaffold', 'admit', 'sweep', 'init', 'mcp'])('refuses policy on %s', (command) => {
  expect(() => originPolicyRequest({ 'require-origin': ['spec'] }, command)).toThrow(TypeError);
});
it.each([{ claim: [] }, { claim: ['C-1'] }, { 'allow-empty': true }, { ref: 'HEAD' }, { ref: '' }, { 'ignore-dirty': true }, { confirm: '1' }, { confirm: '2' }, { confirm: '2.5' }, { confirm: 'NaN' }])('refuses partial, historical, empty or provisional run %j', (options) => {
  expect(() => originPolicyRequest({ 'require-origin': ['spec'], ...options })).toThrow(TypeError);
});
it('accepts larger confirmation, explicit false switches and severity/baseline settings without granting a pass', () => {
  expect(originPolicyRequest({ 'require-origin': ['incident'], confirm: '4', 'allow-empty': false, 'ignore-dirty': false, severity: 'critical', baseline: 'debt.json' })).toEqual(['incident']);
});
