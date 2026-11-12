// #293 decision 2: under --typecheck, a type-check answer is a function of the
// compiler, its options and the program's files. One digest per run
// (`run.typecheck.programDigest`) replaces a check per carried or reused fault;
// a different program carries and reuses nothing; evidence without a digest
// (0.24.0) is checked fault by fault, once. Stub typescript: test/helpers/typecheck-project.mjs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resetRunnerCache } from '../src/probe/runners/shared.mjs';
import { cleanupProjects, commitAll, runProbe, stubProject } from './helpers/typecheck-project.mjs';

afterEach(() => { resetRunnerCache(); cleanupProjects(); delete process.env.TG_TSC_LOG; });

/** How many full type checks the stub saw (the baseline and every per-fault check; never --listFilesOnly or --showConfig). */
const checks = (log) => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((argv) => argv.includes('--noEmit')).length;
const logIn = (dir) => { const log = join(dir, '..', `tsc-${Date.now()}-${Math.random()}.log`); writeFileSync(log, ''); process.env.TG_TSC_LOG = log; return log; };

describe('the program digest', () => {
  it('lets an unchanged program reuse a fault without checking it again', async () => {
    const dir = stubProject();
    const first = await runProbe(dir, { only: ['AFTER'], typecheck: '' });
    expect(first.run.typecheck.programDigest).toMatch(/^[0-9a-f]{64}$/);
    const log = logIn(dir);
    const again = await runProbe(dir, { only: ['AFTER'], typecheck: '', previous: first });
    expect(again.run.reuse).toEqual({ reused: 1, measured: 0 });
    expect(checks(log)).toBe(1); // the baseline only
    expect(again.records[0].detail.typecheck).toBe('clean');
  }, 120_000);

  it('never carries a clean answer across an ambient .d.ts that is in the program and in no import closure', async () => {
    const dir = stubProject();
    const first = await runProbe(dir, { only: ['AFTER'], typecheck: '' });
    expect(first.records[0]).toMatchObject({ verdict: 'killed', detail: { typecheck: 'clean' } });
    mkdirSync(join(dir, 'types'), { recursive: true });
    writeFileSync(join(dir, 'types', 'ambient.d.ts'), 'declare const STRICT: 1;\n');
    commitAll(dir, 'an ambient declaration nothing imports');
    const again = await runProbe(dir, { only: ['AFTER'], typecheck: '', previous: first });
    expect(again.run.typecheck.programDigest).not.toBe(first.run.typecheck.programDigest);
    expect(again.run.reuse).toEqual({ reused: 0, measured: 1 });
    expect(again.records[0]).toMatchObject({ verdict: 'fault-invalid', detail: { typecheck: 'diagnostics' } });
  }, 180_000);

  it('checks 0.24.0 evidence (no digest) fault by fault once; the next run needs no check', async () => {
    const dir = stubProject();
    const first = await runProbe(dir, { only: ['AFTER'], typecheck: '' });
    const old = structuredClone(first);
    delete old.run.typecheck.programDigest;
    let log = logIn(dir);
    const second = await runProbe(dir, { only: ['AFTER'], typecheck: '', previous: old });
    expect(second.run.reuse).toEqual({ reused: 1, measured: 0 });
    expect(checks(log)).toBe(2); // the baseline and the fault, once
    expect(second.run.typecheck.programDigest).toBe(first.run.typecheck.programDigest);
    log = logIn(dir);
    const third = await runProbe(dir, { only: ['AFTER'], typecheck: '', previous: second });
    expect(third.run.reuse).toEqual({ reused: 1, measured: 0 });
    expect(checks(log)).toBe(1);
  }, 180_000);

});
