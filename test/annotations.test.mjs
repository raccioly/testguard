import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanAnnotations, reconcile } from '../src/claims/annotations.mjs';

const dir = mkdtempSync(join(tmpdir(), 'tg-ann-'));
mkdirSync(join(dir, 'src'));
mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
writeFileSync(join(dir, 'src', 'a.mjs'), '// @claim A-1 never leaks\nexport const a = 1;\n/* @claim Z-9 */\n');
writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), '// @claim IGNORED-1\n');
writeFileSync(join(dir, 'notes.txt'), '// @claim NOT-SCANNED\n');

const claim = (id, kind) => ({ id, source: { kind }, faults: [{}] });

describe('scanAnnotations', () => {
  it('finds @claim tokens with file and line, skipping node_modules and non-code files', () => {
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
