// @req FR-02
// @req NFR-03
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locate, mutate, applyFault } from '../src/probe/inject.mjs';

const SRC = 'a();\nb();\na();\n';

describe('locate', () => {
  it('ok when hits equal expectHits', () => expect(locate(SRC, { find: 'b();' }).status).toBe('ok'));
  it('anchor-missing on zero hits', () => expect(locate(SRC, { find: 'z();' }).status).toBe('anchor-missing'));
  it('anchor-ambiguous when hits differ from expectHits', () => {
    expect(locate(SRC, { find: 'a();' })).toMatchObject({ status: 'anchor-ambiguous', hits: 2, expected: 1 });
    expect(locate(SRC, { find: 'a();', expectHits: 2 }).status).toBe('ok');
  });
});

describe('mutate', () => {
  it('replaces the first occurrence by default', () => expect(mutate(SRC, { find: 'a();', replace: 'x();' })).toBe('x();\nb();\na();\n'));
  it('replaces the nth occurrence', () => expect(mutate(SRC, { find: 'a();', replace: 'x();', occurrence: 2, expectHits: 2 })).toBe('a();\nb();\nx();\n'));
  it('supports an empty replacement', () => expect(mutate(SRC, { find: 'b();\n', replace: '' })).toBe('a();\na();\n'));
});

describe('applyFault', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-inject-'));
  mkdirSync(join(dir, 'src'));
  const file = join(dir, 'src', 'x.mjs');

  it('writes the mutation and restore() puts the original back, idempotently', () => {
    writeFileSync(file, SRC);
    const h = applyFault(dir, { file: 'src/x.mjs', find: 'b();', replace: 'B();' });
    expect(h.applied).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('a();\nB();\na();\n');
    h.restore();
    h.restore();
    expect(readFileSync(file, 'utf8')).toBe(SRC);
  });

  it('does not touch the file when the anchor is not ok', () => {
    writeFileSync(file, SRC);
    const h = applyFault(dir, { file: 'src/x.mjs', find: 'nope', replace: 'x' });
    expect(h.applied).toBe(false);
    expect(h.anchor.status).toBe('anchor-missing');
    expect(readFileSync(file, 'utf8')).toBe(SRC);
  });
});
