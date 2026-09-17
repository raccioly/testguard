import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanAnnotations, reconcile } from '../src/claims/annotations.mjs';

const dir = mkdtempSync(join(tmpdir(), 'tg-ann-'));
mkdirSync(join(dir, 'src'));
mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
writeFileSync(join(dir, 'src', 'a.mjs'), '// @claim A-1 never leaks\nexport const a = 1;\n/* @claim Z-9 */\n// the @claim annotations above are real; this sentence is prose\n');
writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), '// @claim IGNORED-1\n');
writeFileSync(join(dir, 'notes.txt'), '// @claim NOT-SCANNED\n');
mkdirSync(join(dir, 'src', '__tests__'));
writeFileSync(join(dir, 'src', '__tests__', 'a.test.mjs'), '// @claim IN-TEST-1\n');
writeFileSync(join(dir, 'src', 'b.spec.mjs'), '// @claim IN-SPEC-1\n');
mkdirSync(join(dir, '.tooling'));
writeFileSync(join(dir, '.tooling', 'x.md'), '@claim HIDDEN-1\n');
mkdirSync(join(dir, 'nested', 'src'), { recursive: true });
writeFileSync(join(dir, 'nested', 'testguard.claims.json'), '{}');
writeFileSync(join(dir, 'nested', 'src', 'n.mjs'), '// @claim NESTED-1\n');

const claim = (id, kind) => ({ id, source: { kind }, faults: [{}] });

describe('scanAnnotations', () => {
  it('finds hyphenated @claim ids with file and line; skips prose, test files, hidden dirs, nested projects, node_modules, non-code files', () => {
    expect(scanAnnotations(dir)).toEqual([
      { id: 'A-1', file: 'src/a.mjs', line: 1 },
      { id: 'Z-9', file: 'src/a.mjs', line: 3 },
    ]);
  });
});

describe('reconcile', () => {
  const ann = scanAnnotations(dir);
  it('reports code annotations with no claim entry as undeclared', () => {
    const r = reconcile({ claims: [claim('A-1', 'annotation')] }, ann);
    expect(r.undeclared.map((a) => a.id)).toEqual(['Z-9']);
    expect(r.annotated).toEqual(['A-1']);
  });
  it('reports annotation-sourced claims no code carries as stale, and leaves other kinds alone', () => {
    const r = reconcile({ claims: [claim('A-1', 'annotation'), claim('Z-9', 'spec'), claim('Y-1', 'annotation'), claim('S-1', 'spec')] }, ann);
    expect(r.stale.map((c) => c.id)).toEqual(['Y-1']);
    expect(r.undeclared).toEqual([]);
  });
});
