// M: a lone pending fault under --fault-workers n > 1 ran beside nothing, so a timeout is not
// re-measured "serially" and is not stamped as if it were (found by a hand-made wrong build).
import { describe, it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { probe } from '../src/probe/probe.mjs';
import { partialBudgetProject } from './helpers/partial-budget-project.mjs';

const base = (project, extra) => ({ projectDir: project.dir, claims: project.claims, runnerName: 'node-test', escalate: false, ...extra });

describe('M: one pending fault under --fault-workers 4 is not re-measured', () => {
  it('a timing-out lone fault gets exactly one measurement, the serial run\'s, and no remeasuredSerially stamp', async () => {
    const project = partialBudgetProject({ hang: 'C1' });
    try {
      const fanned = await probe(base(project, { only: ['C1'], confirmRuns: 1, budgetMs: 2500, faultWorkers: 4 }));
      expect(fanned.records[0].verdict).toBe('timeout');
      expect(fanned.records[0].detail.remeasuredSerially).toBeUndefined();
      expect(fanned.records[0].detail.probeRuns).toHaveLength(1);
      // one baseline run and one probe run: a second measurement of the fault would make it three
      expect(fanned.run.measurements.runnerInvocations).toBe(2);
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);
});

