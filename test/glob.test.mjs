import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { globToRegExp, matchGlobs, walk } from '../src/util/glob.mjs';
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

  it('never descends into a dependency or a build directory — node_modules, .git, dist, build, out, coverage, .next and friends', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-walk-'));
    for (const f of ['test/real.test.mjs', 'node_modules/pkg/inner.test.mjs', 'dist/built.test.mjs', 'coverage/lcov.test.mjs', '.testguard/scratch.test.mjs', '.git/hooks/x.test.mjs',
      // Framework build output carries compiled copies of the application: its
      // writes, and its tests. Scanning it counts the same code twice.
      '.next/server/chunk.test.mjs', 'build/bundle.test.mjs', 'out/static.test.mjs', '.svelte-kit/generated.test.mjs', '.turbo/cache.test.mjs']) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), '');
    }
    expect(walk(dir)).toEqual(['test/real.test.mjs']);
    expect(matchGlobs(dir, ['**/*.test.mjs'])).toEqual(['test/real.test.mjs']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns nothing for no globs', () => {
    expect(matchGlobs(fixture, [])).toEqual([]);
    expect(matchGlobs(fixture, undefined)).toEqual([]);
  });
});
