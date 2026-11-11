// A command budget that runs out while baselines are fanned out (#237 x #235):
// every fault that depends on a baseline is not reached, and a fault that
// needs no baseline keeps its record. Expiry is made deterministic with an
// injected clock advanced from the first baseline stage, never with a sleep.
import { it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { probe } from '../src/probe/probe.mjs';
import { CommandBudget } from '../src/command-budget.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { fanOutProject } from './helpers/fan-out-project.mjs';

const LIMIT = 60_000;

it('a budget cut during the baseline fan-out leaves dependent faults not reached and keeps baseline-free records', async () => {
  const project = fanOutProject(); // SLOW, FAST, MISSING (a bad anchor: no baseline), QUIET
  try {
    let now = 0;
    let peak = 0;
    const budget = new CommandBudget(LIMIT, { now: () => now });
    const onStage = ({ stage }) => {
      if (stage !== 'baseline' || now > LIMIT) return;
      peak = project.worktrees();
      now = LIMIT + 1; // the deadline passes while the baselines are in flight
    };
    const doc = await probe({
      projectDir: project.dir, claims: project.claims, runnerName: 'node-test', confirmRuns: 3, budgetMs: LIMIT,
      escalate: false, faultWorkers: 3, commandBudget: budget, partialOnBudget: true, onStage,
    });
    expect(validate('evidence', doc).errors).toEqual([]);
    expect(doc.records.map((r) => [r.claim.id, r.verdict, r.detail.reason])).toEqual([
      ['SLOW', 'unverifiable', 'not-reached-within-budget'],
      ['FAST', 'unverifiable', 'not-reached-within-budget'],
      ['MISSING', 'unverifiable', 'anchor-missing'],
      ['QUIET', 'unverifiable', 'not-reached-within-budget'],
    ]);
    // Nothing half-measured: a cut baseline is never reported as runs.
    for (const record of doc.records) expect(record.detail.baselineRuns).toEqual([]);
    expect(doc.run.budget).toEqual({ limitMs: LIMIT, exhausted: true, reached: 1, notReached: 3 });
    // Not vacuous: the baselines were fanned out across trees when it ran out, and none remains.
    expect(peak).toBeGreaterThan(2);
    expect(project.worktrees()).toBe(1);
  } finally {
    rmSync(project.dir, { recursive: true, force: true });
    rmSync(project.markers, { recursive: true, force: true });
  }
}, 60_000);
