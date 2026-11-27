import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { repo } from './helpers/gate-project.mjs';

// The tree is reported as changed after the index is built, as if a file had appeared mid-command.
vi.mock('../src/util/glob.mjs', async (importActual) => ({ ...(await importActual()), inventoryChanged: () => true }));

const { computeChangedGate } = await import('../src/gate/changed.mjs');
const { InventoryError } = await import('../src/util/glob.mjs');

describe('the changed-file gate refuses a tree that changed under it (#231)', () => {
  let r;
  beforeEach(() => { r = repo(); });
  afterEach(() => rmSync(r.root, { recursive: true, force: true }));

  it('throws InventoryError instead of reporting coverage the repository never had', () => {
    r.write('src/new-feature.mjs', 'export const x = 1;\n');
    expect(() => computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true })).toThrow(InventoryError);
  });
});
