// raccioly/testguard#287: test files that start a server on one fixed port
// when they load. One fault at a time: ANSWER killed, GREETING survived.
// Side by side, a copy that loads while another holds the port fails to load
// (outcome `error`). The fan-out must still report the serial verdicts.
import { describe, it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { probe } from '../src/probe/probe.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { join } from 'node:path';
import { sharedServerProject } from './helpers/shared-server-project.mjs';
import { freePort } from './helpers/fixed-port-project.mjs';

const SERIAL = { 'ANSWER/F1': 'killed', 'GREETING/F1': 'survived' };
const verdicts = (e) => Object.fromEntries(e.records.map((r) => [`${r.claim.id}/${r.subject.id}`, r.verdict]));

async function run(options, faultWorkers) {
  const project = sharedServerProject(options);
  process.env.TG_SHARED_PORT = String(await freePort());
  try {
    // The claims file is loaded as the CLI does, so a claim's `serial` survives.
    const evidence = await probe({ projectDir: project.dir, claims: loadClaims(join(project.dir, 'testguard.claims.json')), runnerName: 'node-test', confirmRuns: 3, budgetMs: 20_000, escalate: false, faultWorkers });
    expect(validate('evidence', evidence).errors).toEqual([]);
    return evidence;
  } finally {
    delete process.env.TG_SHARED_PORT;
    rmSync(project.dir, { recursive: true, force: true });
  }
}

describe('a fixed port taken when the suite loads', () => {
  it('one fault at a time gives the hand-derived verdicts', async () => {
    expect(verdicts(await run({ files: 2 }, 1))).toEqual(SERIAL);
  }, 120_000);

  it('one defender set: a load error beside another fault is measured again alone, never reported fault-invalid', async () => {
    const e = await run({ files: 1 }, 2);
    expect(verdicts(e)).toEqual(SERIAL);
    // The collision happened (not vacuous), and no reported verdict rests on a load error.
    expect(e.records.some((r) => r.detail.remeasuredSerially)).toBe(true);
    for (const r of e.records) {
      expect(r.detail.probeRuns.some((run) => run.outcome === 'error')).toBe(false);
      if (r.detail.remeasuredSerially) expect(r.detail.probeRuns.every((run) => run.alone)).toBe(true);
    }
  }, 120_000);

  it('two defender sets whose baselines collide are not parallel-safe: every fault probed alone, and the evidence says so', async () => {
    const e = await run({ files: 2 }, 2);
    expect(verdicts(e)).toEqual(SERIAL);
    // The set whose baseline lost the port is held to runs alone, and says why.
    const unsafe = e.records.filter((r) => r.detail.notParallelSafe);
    expect(unsafe.length).toBeGreaterThanOrEqual(1);
    for (const r of unsafe) expect(r.detail.baselineRemeasuredSerially).toBe(true);
    for (const r of e.records) expect(r.detail.probeRuns.every((run) => run.alone)).toBe(true);
  }, 120_000);

  it('a port derived from TESTGUARD_WORKER stays parallel: same verdicts, nothing held back', async () => {
    const e = await run({ files: 2, perWorker: true }, 2);
    expect(verdicts(e)).toEqual(SERIAL);
    expect(e.run.faultWorkers).toBe(2);
    expect(e.records.some((r) => r.detail.notParallelSafe || r.detail.remeasuredSerially || r.detail.baselineRemeasuredSerially)).toBe(false);
  }, 120_000);

});
