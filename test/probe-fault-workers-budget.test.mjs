// `--command-budget` covers every tree of a fan-out (issue #237): when it runs
// out mid-fan-out the probe refuses to publish, and every scratch tree the
// fan-out created is gone by the time the error reaches the caller.
import { it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { probe } from '../src/probe/probe.mjs';
import { createCommandBudget } from '../src/command-budget.mjs';
import { PreconditionError } from '../src/probe/worktree.mjs';
import { fanOutProject } from './helpers/fan-out-project.mjs';

it('a command budget that runs out mid-fan-out throws, and leaves no scratch tree', async () => {
  const project = fanOutProject();
  process.env.TG_FANOUT_MARKERS = project.markers;
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, project.worktrees()); }, 50);
  try {
    // The SLOW defender hangs beside the others, so the budget expires while
    // all three trees are in flight.
    const attempt = probe({
      projectDir: project.dir, claims: project.claims, runnerName: 'node-test', confirmRuns: 3,
      budgetMs: 60_000, escalate: false, faultWorkers: 3, commandBudget: createCommandBudget(3500),
    });
    await expect(attempt).rejects.toThrow(PreconditionError);
    await expect(attempt).rejects.toThrow(/command budget of 3500ms exhausted/);
    expect(peak).toBe(4); // not vacuous: the fan-out was running when the budget ran out
    expect(project.worktrees()).toBe(1);
  } finally {
    clearInterval(sampler);
    delete process.env.TG_FANOUT_MARKERS;
    rmSync(project.dir, { recursive: true, force: true });
    rmSync(project.markers, { recursive: true, force: true });
  }
}, 60_000);
