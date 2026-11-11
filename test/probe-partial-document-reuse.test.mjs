// G: a not-reached record the tool really wrote is re-measured by the next run, proven on what the tool emits.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSpecDoc, readSpecDoc } from '../src/evidence/writer.mjs';
import { isReusable } from '../src/probe/attribution.mjs';
import { probe } from '../src/probe/probe.mjs';
import { CommandBudget } from '../src/command-budget.mjs';
import { partialBudgetProject } from './helpers/partial-budget-project.mjs';

const base = (project, extra) => ({ projectDir: project.dir, claims: project.claims, runnerName: 'node-test', escalate: false, ...extra });

describe('G: a not-reached record the tool really wrote is re-measured by the next run', () => {
  it('goes through a written partial document, and carries no dependency closure, so reuse is refused twice over', async () => {
    const project = partialBudgetProject();
    const out = mkdtempSync(join(tmpdir(), 'tg-partial-doc-'));
    try {
      let now = 0;
      const LIMIT = 60_000;
      const budget = new CommandBudget(LIMIT, { now: () => now });
      const seen = new Set();
      const onStage = ({ claimId, stage }) => {
        if (stage !== 'probe' || seen.has(claimId)) return;
        seen.add(claimId);
        if (seen.size === 3) now = LIMIT + 1;
      };
      const partial = await probe(base(project, { confirmRuns: 1, budgetMs: LIMIT, commandBudget: budget, partialOnBudget: true, onStage }));
      const path = join(out, 'evidence-partial.json');
      writeSpecDoc('evidence', path, partial);
      const previous = readSpecDoc('evidence', path);
      const notReached = previous.records.filter((r) => r.detail.reason === 'not-reached-within-budget');
      expect(notReached.map((r) => r.claim.id)).toEqual(['C3', 'C4']);
      // What the tool emits has no dependency closure: the first line of defence.
      for (const r of notReached) expect(r.inputs.dependencyHashes).toBeUndefined();
      // And with a closure supplied, the reason guard alone still refuses it.
      const current = (r) => ({ claim: r.claim, inputs: { ...r.inputs, dependencyHashes: {}, dependencyClosure: 'complete', testUniverseHash: 'u', discoveryHashes: {} }, requested: r.defenders.requested, resolved: [], selectionSource: r.defenders.selectionSource, contentHash: r.subject.contentHash });
      for (const r of notReached) {
        const withClosure = { ...r, inputs: current(r).inputs };
        expect(isReusable(withClosure, current(r))).toBe(false);
      }
      const next = await probe(base(project, { confirmRuns: 1, budgetMs: LIMIT, previous, toolVersion: previous.tool.version }));
      expect(next.records.map((r) => [r.claim.id, r.verdict, r.reusedFrom === undefined])).toEqual([['C1', 'killed', false], ['C2', 'killed', false], ['C3', 'killed', true], ['C4', 'killed', true]]);
    } finally {
      rmSync(project.dir, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  }, 90_000);
});
