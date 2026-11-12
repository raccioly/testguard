#!/usr/bin/env node
/**
 * Verdict equality under the default fan-out (issue #270): every known-answer
 * fixture is probed one fault at a time and with faults fanned out, and the
 * two runs must give the same verdict and reason for every fault, in the same
 * order, and both must match the fixture's oracle. Each run gets a fresh copy,
 * so a fixture's own state (a flake counter) never carries from one to the
 * other.
 *
 *   node bench/fan-out-equality.mjs [--fault-workers <n>] [--only <name,...>]
 *
 * --fault-workers defaults to the automatic width, at least 2 so a fan-out
 * really happens on a small machine. Exit 0 when every fixture agrees.
 * Not part of `npm test`: a few minutes of real runners (vitest, jest,
 * node:test, pytest, unittest, Playwright, tsc).
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { probe } from '../src/probe/probe.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { autoFaultWorkers } from '../src/probe/fan-out.mjs';
import { validate } from '../spec/lib/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { 'fault-workers': { type: 'string' }, only: { type: 'string' } } });
const width = Number(values['fault-workers'] ?? Math.max(2, autoFaultWorkers(availableParallelism())));

const FIXTURES = [
  { name: 'vitest', dir: 'known-answer', modules: 'root', budgetMs: 30_000 },
  { name: 'jest', dir: 'known-answer-jest', modules: 'root', runnerName: 'jest', budgetMs: 60_000, escalate: false },
  { name: 'node-test', dir: 'known-answer-node', runnerName: 'node-test', budgetMs: 10_000 },
  { name: 'pytest', dir: 'known-answer-python', runnerName: 'pytest', budgetMs: 60_000, escalate: false },
  { name: 'unittest', dir: 'known-answer-python', runnerName: 'unittest', budgetMs: 60_000, escalate: false },
  { name: 'playwright', dir: 'known-answer-playwright', modules: 'own', budgetMs: 60_000, escalate: false },
  { name: 'typescript', dir: 'known-answer-typescript', modules: 'own', budgetMs: 120_000, escalate: false, typecheck: '' },
].filter((f) => !values.only || values.only.split(',').includes(f.name));

function scratchOf(fixture) {
  const src = join(ROOT, 'fixtures', fixture.dir);
  const dir = mkdtempSync(join(tmpdir(), `tg-equality-${fixture.name}-`));
  cpSync(src, dir, { recursive: true, filter: (p) => !/node_modules|\.flake-counter|test-results|\.testguard|__pycache__|counter/.test(p.slice(src.length)) });
  if (fixture.modules === 'root') symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  if (fixture.modules === 'own') {
    if (!existsSync(join(src, 'node_modules'))) throw new Error(`${fixture.name}: run npm ci --prefix fixtures/${fixture.dir} first`);
    symlinkSync(join(src, 'node_modules'), join(dir, 'node_modules'), 'dir');
  }
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'fixture']]) {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  }
  return dir;
}

async function measure(fixture, faultWorkers) {
  const dir = scratchOf(fixture);
  try {
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
    const started = performance.now();
    const evidence = await probe({
      projectDir: dir, claims: loadClaims(join(dir, 'testguard.claims.json')), confirmRuns: expected.confirmRuns ?? 3,
      mode: 'worktree', budgetMs: fixture.budgetMs, toolVersion: 'equality', faultWorkers,
      ...(fixture.runnerName ? { runnerName: fixture.runnerName } : {}),
      ...(fixture.escalate === false ? { escalate: false } : {}),
      ...(fixture.typecheck !== undefined ? { typecheck: fixture.typecheck } : {}),
    });
    const errors = validate('evidence', evidence).errors;
    if (errors.length) throw new Error(`${fixture.name}: evidence does not conform: ${JSON.stringify(errors.slice(0, 3))}`);
    return {
      ms: performance.now() - started,
      expected: expected.expected,
      order: evidence.records.map((r) => `${r.claim.id}/${r.subject.id}`),
      verdicts: Object.fromEntries(evidence.records.map((r) => [`${r.claim.id}/${r.subject.id}`, `${r.verdict}${r.detail.reason ? ` (${r.detail.reason})` : ''}`])),
      guard: evidence.run.measurements,
      unsafe: evidence.records.filter((r) => r.detail.notParallelSafe).length,
      remeasured: evidence.records.filter((r) => r.detail.remeasuredSerially).length,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let failed = 0;
const rows = [];
for (const fixture of FIXTURES) {
  const serial = await measure(fixture, 1);
  const fanned = await measure(fixture, width);
  const sameOrder = JSON.stringify(serial.order) === JSON.stringify(fanned.order);
  const diff = Object.keys(serial.verdicts).filter((k) => serial.verdicts[k] !== fanned.verdicts[k]);
  const oracle = Object.entries(serial.expected).filter(([k, v]) => !String(fanned.verdicts[k] ?? '').startsWith(v.verdict) || (v.reason && !String(fanned.verdicts[k]).includes(`(${v.reason})`)));
  const ok = sameOrder && diff.length === 0 && oracle.length === 0;
  if (!ok) failed++;
  rows.push(`| ${fixture.name} | ${serial.order.length} | ${ok ? 'equal' : 'DIFFERENT'} | ${(serial.ms / 1000).toFixed(1)} s | ${(fanned.ms / 1000).toFixed(1)} s | ${fanned.guard.aloneConfirmRuns ?? 0} / ${fanned.remeasured} / ${fanned.unsafe} |`);
  if (!sameOrder) console.error(`${fixture.name}: order differs`);
  for (const k of diff) console.error(`${fixture.name}: ${k} serial ${serial.verdicts[k]} vs fan-out ${fanned.verdicts[k]}`);
  for (const [k, v] of oracle) console.error(`${fixture.name}: ${k} expected ${v.verdict}${v.reason ? ` (${v.reason})` : ''}, fan-out ${fanned.verdicts[k]}`);
}
console.log(`fan-out width ${width} on ${availableParallelism()} CPUs\n`);
console.log('| fixture | faults | serial vs fan-out | serial | fan-out | confirmed alone / re-measured / not parallel-safe |');
console.log('|---|---|---|---|---|---|');
for (const row of rows) console.log(row);
process.exit(failed ? 1 : 0);
