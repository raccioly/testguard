// `--typecheck` under `--fault-workers` (#236 x #237): the fan-out reports
// what a serial run reports, and every type check runs while faults are
// planned, one at a time on the first tree, so no incremental build-info is
// ever shared between two scratch trees.
import { it, expect } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { fanOutProject } from './helpers/fan-out-project.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const write = (root, file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };

/**
 * The fan-out project plus a stub `tsc` that lists the three sources as its
 * program (with checkJs, so .mjs files are judged) and refuses any of them
 * that contains `BAD`, and one more claim
 * whose replacement it refuses.
 */
function typecheckedProject() {
  const project = fanOutProject();
  const { dir } = project;
  write(dir, 'tsconfig.json', '{}\n');
  write(dir, 'node_modules/typescript/package.json', JSON.stringify({ name: 'typescript', version: '9.9.9', bin: { tsc: 'bin/tsc' } }));
  write(dir, 'node_modules/typescript/bin/tsc', `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const sources = ['src/fast.mjs', 'src/quiet.mjs', 'src/slow.mjs'];
if (args.includes('--listFilesOnly')) { process.stdout.write(sources.map((f) => path.resolve(f)).join('\\n') + '\\n'); process.exit(0); }
if (args.includes('--showConfig')) { process.stdout.write('{"compilerOptions":{"allowJs":true,"checkJs":true}}'); process.exit(0); }
const bad = sources.find((f) => fs.readFileSync(f, 'utf8').includes('BAD'));
if (bad) { process.stdout.write(bad + '(1,1): error TS2322: refused\\n'); process.exit(2); }
process.exit(0);
`);
  const claims = structuredClone(project.claims);
  claims.claims.push({
    id: 'REFUSED', statement: 'REFUSED holds.', source: { kind: 'manual', ref: 'test' }, severity: 'high', producedBy: { producer: 'human' }, defendedBy: ['test/fast.test.mjs'],
    faults: [{ id: 'F1', description: 'refused by the type check', faultClass: 'return-altered', file: 'src/fast.mjs', find: '=> 1', replace: '=> 1 /* BAD */', producedBy: { producer: 'human' } }],
  });
  const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'add', '-A'], { cwd: dir });
  const c = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'typecheck'], { cwd: dir });
  if (r.status !== 0 || c.status !== 0) throw new Error('could not commit the type-checked project');
  return { ...project, claims };
}

it('--typecheck with --fault-workers 3 gives the serial records, and type-checks only while planning', async () => {
  const project = typecheckedProject();
  try {
    const run = async (faultWorkers) => {
      const stages = [];
      const evidence = await probe({
        projectDir: project.dir, claims: project.claims, runnerName: 'node-test', confirmRuns: 3, budgetMs: 10_000,
        escalate: false, typecheck: '', faultWorkers, onStage: (s) => stages.push(`${s.claimId}:${s.stage}`),
      });
      return { evidence, stages };
    };
    const serial = await run(1);
    const fanned = await run(3);
    const strip = (value) => (Array.isArray(value) ? value.map(strip)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'durationMs').map(([k, v]) => [k, strip(v)])) : value);
    expect(fanned.evidence.records.map(strip)).toEqual(serial.evidence.records.map(strip));
    const verdicts = Object.fromEntries(fanned.evidence.records.map((r) => [r.claim.id, [r.verdict, r.detail.typecheck, r.detail.reason ?? null]]));
    expect(verdicts.REFUSED).toEqual(['fault-invalid', 'diagnostics', 'replacement-does-not-typecheck']);
    expect(verdicts.FAST).toEqual(['killed', 'clean', null]);
    expect(fanned.evidence.run.typecheck).toEqual(serial.evidence.run.typecheck);
    expect(fanned.evidence.run.faultWorkers).toBe(3);
    // Every type check precedes the first faulted test run: they all ran while
    // planning, on the first tree, before any tree was handed a fault.
    const lastTypecheck = fanned.stages.findLastIndex((s) => s.endsWith(':typecheck'));
    const firstProbe = fanned.stages.findIndex((s) => s.endsWith(':probe'));
    expect(lastTypecheck).toBeGreaterThan(-1);
    expect(lastTypecheck).toBeLessThan(firstProbe);
    expect(validate('evidence', fanned.evidence).errors).toEqual([]);
    expect(project.worktrees()).toBe(1);
  } finally {
    rmSync(project.dir, { recursive: true, force: true });
    rmSync(project.markers, { recursive: true, force: true });
  }
}, 60_000);
