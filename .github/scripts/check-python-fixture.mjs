#!/usr/bin/env node
/**
 * Compare a probe of `fixtures/known-answer-python` against its oracle.
 *
 * Shared by both CI legs so the stdlib engine and pytest are held to exactly
 * the same expectations — the point of the fixture is that two engines with
 * different report shapes must not disagree about a single verdict.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [evidencePath, expectedEngine] = process.argv.slice(2);
if (!evidencePath) {
  console.error('usage: check-python-fixture.mjs <evidence.json> [engine]');
  process.exit(2);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const oracle = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'known-answer-python', 'expected.json'), 'utf8')).expected;
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));

const problems = [];
if (expectedEngine && evidence.run.runner.name !== expectedEngine) {
  problems.push(`runner was ${evidence.run.runner.name}, expected ${expectedEngine}`);
}

const seen = new Set();
for (const r of evidence.records) {
  const key = `${r.claim.id}/${r.subject.id}`;
  seen.add(key);
  const want = oracle[key];
  if (!want) { problems.push(`${key}: not in expected.json`); continue; }
  if (want.verdict !== r.verdict) problems.push(`${key}: ${r.verdict}, expected ${want.verdict}`);
  if (want.reason && want.reason !== r.detail.reason) problems.push(`${key}: reason ${r.detail.reason}, expected ${want.reason}`);
  if (Boolean(want.targetNotImported) !== Boolean(r.detail.targetNotImported)) {
    problems.push(`${key}: targetNotImported ${Boolean(r.detail.targetNotImported)}, expected ${Boolean(want.targetNotImported)}`);
  }
  // The negative control is pinned too, not merely tolerated: a fixture that
  // accepted either answer would stop defending the one behaviour it exists
  // to prove, and the verdict alone cannot tell "the defenders reached this
  // file and said nothing" from "they never reached it".
  if ((want.negativeControl ?? null) !== (r.detail.negativeControl ?? null)) {
    problems.push(`${key}: negativeControl ${r.detail.negativeControl ?? 'absent'}, expected ${want.negativeControl ?? 'absent'}`);
  }
}
for (const key of Object.keys(oracle)) if (!seen.has(key)) problems.push(`${key}: expected but never probed`);

if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log(`python fixture verdicts match expected.json under ${evidence.run.runner.name}: ${evidence.records.length} records`);
