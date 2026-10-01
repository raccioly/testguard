import { describe, expect, it } from 'vitest';
import { intentInputRequest } from '../src/scaffold/request.mjs';

const commit = 'a'.repeat(40);
const request = (values, rest = {}) => intentInputRequest({ command: 'scaffold', values, ...rest });
describe('explicit intent input request admission', () => {
  it('preserves ordinary scaffold and append without selecting an input mode', () => {
    expect(request({})).toBeNull();
    expect(request({ into: ['draft.json'], claim: ['C1'] }, { files: ['guard.mjs'] })).toBeNull();
  });
  it('returns only immutable explicit selectors, not authored claims or origins', () => {
    for (const [values, expected] of [
      [{ 'from-document': ['requirements.md'] }, { kind: 'document', file: 'requirements.md' }],
      [{ 'from-fix': [commit] }, { kind: 'fix', commit }],
      [{ 'from-fix': ['b'.repeat(64)], json: true }, { kind: 'fix', commit: 'b'.repeat(64) }],
    ]) {
      const result = request(values, { suppliedOptions: [...Object.keys(values)] });
      expect(result).toEqual(expected); expect(Object.isFrozen(result)).toBe(true);
    }
  });
  it('refuses the wrong command even for an otherwise valid request', () => {
    expect(() => request({ 'from-document': ['requirements.md'] }, { command: 'status' })).toThrow(/only valid on scaffold/);
  });
  it('refuses both modes rather than silently preferring one', () => {
    expect(() => request({ 'from-document': ['requirements.md'], 'from-fix': [commit] })).toThrow(/exactly one input mode/);
  });
  it.each(['from-document', 'from-fix'])('refuses malformed %s selectors', mode => {
    for (const selector of [[], [''], [' '], ['requirements.md', 'requirements.md'], 'requirements.md', [null], [' x'], ['x '], ['x\0y'], ['é'.repeat(2049)]]) {
      expect(() => request({ [mode]: selector })).toThrow(/exactly one|selector/);
    }
  });
  it('accepts selector byte ceiling and refuses above it independently of character count', () => {
    expect(request({ 'from-document': ['é'.repeat(2048)] }).file).toHaveLength(2048);
    expect(() => request({ 'from-document': ['x'.repeat(4097)] })).toThrow(/selector-byte-limit/);
  });
  it.each(['HEAD', 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(40), '--help', `${commit}..${commit}`])('refuses nonliteral fix %s', value => {
    expect(() => request({ 'from-fix': [value] })).toThrow(/full-object-id/);
  });
  it('refuses positional sources instead of choosing an implicit workflow', () => {
    expect(() => request({ 'from-document': ['requirements.md'] }, { files: ['guard.mjs'] })).toThrow(/positional source/);
  });
  it.each(['into', 'claim', 'claims', 'out', 'budget', 'max', 'serial', 'require-origin'])('refuses explicitly supplied --%s even if its value is a default', option => {
    expect(() => request({ 'from-document': ['requirements.md'] }, { suppliedOptions: ['from-document', option] })).toThrow(/cannot use/);
  });
  it.each(['into', 'claim', 'claims', 'out'])('refuses conflicting direct-handler value --%s without token metadata', option => {
    expect(() => request({ 'from-fix': [commit], [option]: [] })).toThrow(/cannot use/);
  });
});
