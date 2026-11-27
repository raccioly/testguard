// `sharedExternalState: true` (#329): a runner that deploys to, or tests
// against, one shared org or server cannot have two faults in flight, because
// the second fault's code would run beside the first one's. The engine
// decides it, not the user: one fault at a time and one tree, whatever
// --fault-workers asked for, and the evidence says it was the runner.
import { describe, it, expect, afterAll } from 'vitest';
import { rmSync, readFileSync } from 'node:fs';
import { probe } from '../src/probe/probe.mjs';
import { RUNNERS } from '../src/probe/runners/index.mjs';
import * as nodeTest from '../src/probe/runners/node-test.mjs';
import { runnerSharesExternalState, applySharedExternalState } from '../src/probe/fan-out.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { fanOutProject } from './helpers/fan-out-project.mjs';

describe('the decision', () => {
  it('is true when any runner in the run declares it, and only for the literal true', () => {
    expect(runnerSharesExternalState([{ name: 'a' }, { name: 'b', sharedExternalState: true }])).toBe(true);
    expect(runnerSharesExternalState([{ name: 'a' }, { name: 'b', sharedExternalState: false }, { name: 'c', sharedExternalState: 'yes' }])).toBe(false);
    expect(runnerSharesExternalState([])).toBe(false);
  });

  it('forces one fault at a time and says why; it changes nothing else', () => {
    expect(applySharedExternalState({ faultWorkers: 4, source: 'auto' }, [{ sharedExternalState: true }]))
      .toEqual({ faultWorkers: 1, source: 'runner', forced: true, asked: 4 });
    expect(applySharedExternalState({ faultWorkers: 1, source: 'flag' }, [{ sharedExternalState: true }]))
      .toEqual({ faultWorkers: 1, source: 'flag', forced: false, asked: 1 });
    expect(applySharedExternalState({ faultWorkers: 4, source: 'auto' }, [{}])).toEqual({ faultWorkers: 4, source: 'auto', forced: false, asked: 4 });
  });
});

describe('the evidence shape', () => {
  it('a run forced to one fault at a time records source runner and no fan-out', () => {
    const doc = JSON.parse(readFileSync(new URL('../spec/conformance/examples/evidence.json', import.meta.url), 'utf8'));
    doc.run.faultWorkersSource = 'runner';
    expect(validate('evidence', doc).errors).toEqual([]);
    doc.run.faultWorkers = 3;
    expect(validate('evidence', doc).ok).toBe(false);
  });
});

describe('a probe of a runner that shares external state', () => {
  let project;
  afterAll(() => { delete RUNNERS['shared-state-test']; if (project) { rmSync(project.dir, { recursive: true, force: true }); rmSync(project.markers, { recursive: true, force: true }); } });

  it('uses one scratch tree although three fault workers were asked for', async () => {
    RUNNERS['shared-state-test'] = { ...nodeTest, sharedExternalState: true };
    project = fanOutProject({ only: ['FAST', 'QUIET'] });
    let peak = 0;
    const sampler = setInterval(() => { peak = Math.max(peak, project.worktrees()); }, 25);
    const warnings = [];
    let evidence;
    try {
      evidence = await probe({
        projectDir: project.dir, claims: project.claims, runnerName: 'shared-state-test', confirmRuns: 1,
        budgetMs: 5000, escalate: false, faultWorkers: 3, faultWorkersSource: 'flag', onWarn: (m) => warnings.push(m),
      });
    } finally { clearInterval(sampler); }
    expect(peak).toBe(2); // the project and one scratch tree
    expect(evidence.run).not.toHaveProperty('faultWorkers');
    expect(evidence.run.faultWorkersSource).toBe('runner');
    expect(warnings.join('\n')).toMatch(/shares external state/);
    expect(validate('evidence', evidence).errors).toEqual([]);
  }, 60_000);
});
