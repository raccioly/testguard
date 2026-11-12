// N: after a command budget expires, the progress stream (what `--progress ndjson` consumers read)
// is the whole record list, in order (found by a hand-made wrong build).
import { describe, it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { probe } from '../src/probe/probe.mjs';
import { CommandBudget } from '../src/command-budget.mjs';
import { partialBudgetProject } from './helpers/partial-budget-project.mjs';

const base = (project, extra) => ({ projectDir: project.dir, claims: project.claims, runnerName: 'node-test', escalate: false, ...extra });

describe('N: the progress stream after a budget expiry is the full record list, in order', () => {
  it('delivers every record once, measured prefix first and not-reached suffix after, equal to the document', async () => {
    const project = partialBudgetProject();
    try {
      let now = 0;
      const LIMIT = 60_000;
      const budget = new CommandBudget(LIMIT, { now: () => now });
      const seen = new Set();
      const onStage = ({ claimId, stage }) => {
        if (stage !== 'probe' || seen.has(claimId)) return;
        seen.add(claimId);
        if (seen.size === 2) now = LIMIT + 1;
      };
      const streamed = [];
      const doc = await probe(base(project, { only: ['C1', 'C2', 'C3'], confirmRuns: 1, budgetMs: LIMIT, commandBudget: budget, partialOnBudget: true, onStage, onProgress: (r) => streamed.push(r) }));
      expect(doc.records.map((r) => r.claim.id)).toEqual(['C1', 'C2', 'C3']);
      expect(streamed.map((r) => `${r.claim.id}/${r.subject.id}:${r.verdict}`)).toEqual(doc.records.map((r) => `${r.claim.id}/${r.subject.id}:${r.verdict}`));
      expect(streamed.slice(1).map((r) => r.detail.reason)).toEqual(['not-reached-within-budget', 'not-reached-within-budget']);
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);
});

