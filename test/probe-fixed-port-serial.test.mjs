// The serial answer for the fixed-port project (issue #270), measured, not
// assumed: the oracle probe-fixed-port.test.mjs holds the fan-out to.
import { it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { probe } from '../src/probe/probe.mjs';
import { fixedPortProject, freePort } from './helpers/fixed-port-project.mjs';

it('one fault at a time: ANSWER killed, GREETING survived', async () => {
  const project = fixedPortProject();
  process.env.TG_FIXED_PORT = String(await freePort());
  try {
    const evidence = await probe({ projectDir: project.dir, claims: project.claims, runnerName: 'node-test', confirmRuns: 3, budgetMs: 20_000, escalate: false, faultWorkers: 1 });
    expect(Object.fromEntries(evidence.records.map((r) => [`${r.claim.id}/${r.subject.id}`, r.verdict]))).toEqual({ 'ANSWER/F1': 'killed', 'GREETING/F1': 'survived' });
    expect(evidence.run.faultWorkers).toBeUndefined();
  } finally {
    delete process.env.TG_FIXED_PORT;
    rmSync(project.dir, { recursive: true, force: true });
  }
}, 120_000);
