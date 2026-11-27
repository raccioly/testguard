// Issue #273: a relative import that leaves the project directory reaches
// repository source the defenders run. Dropping it silently left the closure
// `complete` and smaller: `probe --changed` did not select the claim when the
// outside file changed, and verdict reuse never saw the change. It is treated
// like a workspace package outside the project (#268): the closure is
// indeterminate, never smaller.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createImportResolver } from '../src/probe/imports.mjs';
import { createDependencyHasher } from '../src/probe/dependencies.mjs';
import { resolveProbeScope } from '../src/probe/scope.mjs';
import { commit, workspaceProject } from './helpers/workspace-project.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

const OUTSIDE_IMPORT = {
  'packages/planner/src/estimate.js': "import { area } from '../../geometry/src/shapes.js';\nexport const estimate = (w, h, rate) => area(w, h) * rate;\n",
};
const project = () => {
  const p = workspaceProject({ files: OUTSIDE_IMPORT });
  roots.push(p.root);
  return { ...p, planner: join(p.root, 'packages/planner') };
};

describe('a relative import that leaves the project is not silently dropped', () => {
  it('makes the closure indeterminate and names the importing file and specifier', () => {
    const { planner } = project();
    const result = createImportResolver(planner).closure([join(planner, 'test/estimate.test.js')]);
    expect(result.status).toBe('indeterminate');
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unreadable-module', file: 'src/estimate.js', specifier: '../../geometry/src/shapes.js' })]));
    expect(result.files.some((file) => file.startsWith('..'))).toBe(false);
  });

  it('leaves an import that stays inside the project complete', () => {
    const { planner } = project();
    writeFileSync(join(planner, 'src/rate.js'), 'export const rate = 2;\n');
    writeFileSync(join(planner, 'src/estimate.js'), "import { rate } from './rate.js';\nexport const estimate = (w, h) => w * h * rate;\n");
    const result = createImportResolver(planner).closure([join(planner, 'test/estimate.test.js')]);
    expect(result.status).toBe('complete');
  });

  it('makes verdict reuse refuse: the hasher reports an indeterminate closure', () => {
    const { planner } = project();
    const inputs = createDependencyHasher(planner, { cache: false }).inputsFor(['src/estimate.js', 'test/estimate.test.js']);
    expect(inputs.dependencyClosure).toBe('indeterminate');
  });

  it('probe --changed selects the claim when the outside file changes', () => {
    const p = project();
    const claims = {
      schemaVersion: 1,
      claims: [{
        id: 'ESTIMATE', statement: 'Estimate holds.', source: { kind: 'spec', ref: 'README.md' }, severity: 'high',
        producedBy: { producer: 'agent', by: 'fixture' }, defendedBy: ['test/estimate.test.js'],
        faults: [{ id: 'F1', description: 'Break it.', faultClass: 'return-altered', file: 'src/estimate.js', find: '* rate', replace: '* 1', producedBy: { producer: 'agent', by: 'fixture' } }],
      }],
    };
    writeFileSync(join(p.root, 'packages/geometry/src/shapes.js'), `${readFileSync(join(p.root, 'packages/geometry/src/shapes.js'), 'utf8')}// edited\n`);
    commit(p.root);
    const scope = resolveProbeScope({ projectDir: p.planner, claims, ref: p.base });
    expect(scope.files).toEqual([]);
    expect(scope.selected).toEqual(['ESTIMATE']);
  });
});
