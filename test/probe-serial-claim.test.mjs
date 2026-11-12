// A claim declared `serial: true` (raccioly/testguard#287) is probed alone,
// after the fan-out, and its records say so; claims that are not declared stay
// in the fan-out. Kept to one probe on purpose: this file defends a self-claim.
import { describe, it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { probe } from '../src/probe/probe.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { sharedServerProject } from './helpers/shared-server-project.mjs';
import { freePort } from './helpers/fixed-port-project.mjs';

const SERIAL = { 'ANSWER/F1': 'killed', 'GREETING/F1': 'survived' };
const verdicts = (e) => Object.fromEntries(e.records.map((r) => [`${r.claim.id}/${r.subject.id}`, r.verdict]));

async function run(options, faultWorkers) {
  const project = sharedServerProject(options);
  process.env.TG_SHARED_PORT = String(await freePort());
  try {
    const evidence = await probe({ projectDir: project.dir, claims: loadClaims(join(project.dir, 'testguard.claims.json')), runnerName: 'node-test', confirmRuns: 3, budgetMs: 20_000, escalate: false, faultWorkers });
    expect(validate('evidence', evidence).errors).toEqual([]);
    return evidence;
  } finally {
    delete process.env.TG_SHARED_PORT;
    rmSync(project.dir, { recursive: true, force: true });
  }
}

describe('a claim declared serial', () => {
  it('a claim declared serial is probed alone after the fan-out, and says so; the rest is not held back', async () => {
    const e = await run({ files: 2, perWorker: true, serial: true }, 2);
    expect(verdicts(e)).toEqual(SERIAL);
    const [answer, greeting] = e.records;
    expect(answer.detail.serialDeclared).toBe(true);
    expect(answer.detail.probeRuns.every((run) => run.alone)).toBe(true);
    expect(greeting.detail.serialDeclared).toBeUndefined();
  }, 120_000);
});
