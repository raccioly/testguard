// Real-probe acceptance for #263 and #268 on a two-package workspace under
// node:test: a fault in one package defended by a test in its sibling, reached
// only through the workspace link. Mandatory in npm test and CI; the claims
// name the fast defenders (workspace-scratch, workspace-closure).
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probe } from '../src/probe/probe.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { claimsDoc, commit, workspaceProject } from './helpers/workspace-project.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

const provenance = { producer: 'agent', by: 'fixture' };
// A fault in the planner whose kill depends on geometry's code: with a
// symmetric `area` swapping the arguments changes nothing (survived); once
// geometry changes so `area` is asymmetric but `area(3, 4)` is still 12, the
// baseline stays green and the same fault is killed.
const swap = {
  id: 'SWAP-ARGS', statement: 'The estimate passes width then height.', source: { kind: 'spec', ref: 'README.md' }, severity: 'high',
  producedBy: provenance, defendedBy: ['packages/planner/test/estimate.test.js'],
  faults: [{ id: 'F1', description: 'Swap the arguments.', faultClass: 'return-altered', file: 'packages/planner/src/estimate.js', find: 'area(w, h)', replace: 'area(h, w)', producedBy: provenance }],
};
const claimsWith = (...extra) => { const doc = claimsDoc(); doc.claims.push(...extra); return doc; };
const verdicts = (evidence) => Object.fromEntries(evidence.records.map((r) => [`${r.claim.id}/${r.subject.id}`, { verdict: r.verdict, reason: r.detail.reason, reused: Boolean(r.reusedFrom) }]));
const run = (dir, claims, extra = {}) => probe({ projectDir: dir, claims, runnerName: 'node-test', confirmRuns: 3, budgetMs: 20_000, mode: 'worktree', toolVersion: 'test', ...extra });

describe('a workspace package defended through its link', () => {
  it.each(['npm', 'pnpm'])('kills the fault the sibling package defends (%s layout)', async (layout) => {
    const p = workspaceProject({ layout });
    roots.push(p.root);
    const evidence = await run(p.dir, claimsDoc());
    expect(validate('evidence', evidence).errors).toEqual([]);
    expect(verdicts(evidence)['ESTIMATE-USES-AREA/F1']).toMatchObject({ verdict: 'killed' });
    expect(verdicts(evidence)['UNITS-CONVERT/F1']).toMatchObject({ verdict: 'killed' });
  }, 60_000);

  it('kills it under --fault-workers 2 as well', async () => {
    const p = workspaceProject();
    roots.push(p.root);
    const evidence = await run(p.dir, claimsDoc(), { faultWorkers: 2 });
    expect(verdicts(evidence)['ESTIMATE-USES-AREA/F1']).toMatchObject({ verdict: 'killed' });
  }, 60_000);

  it('does not reuse a verdict across a workspace-package change that keeps the baseline green', async () => {
    const p = workspaceProject({ files: { 'testguard.claims.json': JSON.stringify(claimsWith(swap), null, 2) } });
    roots.push(p.root);
    const claims = claimsWith(swap);
    const first = await run(p.dir, claims);
    expect(verdicts(first)['SWAP-ARGS/F1']).toMatchObject({ verdict: 'survived' });
    const shapes = join(p.root, 'packages/geometry/src/shapes.js');
    writeFileSync(shapes, readFileSync(shapes, 'utf8').replace('w * h', 'w * h + (w - 3)'));
    commit(p.root);
    const second = await run(p.dir, claims, { previous: first });
    expect(verdicts(second)['SWAP-ARGS/F1']).toEqual({ verdict: 'killed', reason: undefined, reused: false });
    expect(validate('evidence', second).errors).toEqual([]);
  }, 90_000);
});
