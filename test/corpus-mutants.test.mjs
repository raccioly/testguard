// The corpus's tool mutants (corpus/tool-mutants/) are patches against src/.
// They drift as src/ changes; a patch that no longer applies measures nothing,
// so the change that broke it must regenerate it in the same pull request.
// This runs no probe: it only asks git whether each patch applies.
import { describe, it, expect } from 'vitest';
import { checkMutants, loadManifest } from '../corpus/lib/mutants.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('corpus tool mutants', () => {
  it('lists at least ten mutants, each with a patch file and at least one target', () => {
    const mutants = loadManifest();
    expect(mutants.length).toBeGreaterThanOrEqual(10);
    for (const m of mutants) {
      expect(existsSync(join(ROOT, 'corpus', 'tool-mutants', m.patch)), m.patch).toBe(true);
      expect(m.targets.length, m.name).toBeGreaterThan(0);
    }
  });

  it('every patch applies to the current src/ (regenerate a drifted one with the change that moved it)', () => {
    const drifted = checkMutants(ROOT).filter((m) => !m.applies);
    expect(drifted).toEqual([]);
  }, 60_000);
});
