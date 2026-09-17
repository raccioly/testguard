import { describe, it, expect } from 'vitest';
import { globToRegExp, matchGlobs } from '../src/util/glob.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const fixture = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'known-answer');

describe('glob', () => {
  it.each([
    ['test/redact.test.mjs', 'test/redact.test.mjs', true],
    ['test/*.test.mjs', 'test/redact.test.mjs', true],
    ['test/*.test.mjs', 'test/deep/redact.test.mjs', false],
    ['**/*.test.mjs', 'test/deep/redact.test.mjs', true],
    ['**/*.test.mjs', 'redact.test.mjs', true],
    ['src/**', 'src/a/b.mjs', true],
    ['src/?.mjs', 'src/a.mjs', true],
    ['src/a.mjs', 'src/aXmjs', false],
  ])('%s vs %s → %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });

  it('matches files under a root and skips node_modules', () => {
    const files = matchGlobs(fixture, ['**/*.test.mjs']);
    expect(files).toEqual(['test/export-mocked.test.mjs', 'test/flaky.test.mjs', 'test/redact.test.mjs']);
  });

  it('returns nothing for no globs', () => {
    expect(matchGlobs(fixture, [])).toEqual([]);
    expect(matchGlobs(fixture, undefined)).toEqual([]);
  });
});
