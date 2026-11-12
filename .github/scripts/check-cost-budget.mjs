#!/usr/bin/env node
/**
 * Fail CI when the self-probe gate outgrows its budget.
 *
 * The decision lives in `src/probe/cost.mjs` as a pure function, unit-tested
 * and covered by a self-claim; this script is only wiring — read the evidence,
 * read the budget, print, choose an exit code.
 *
 * The ceiling is in NORMALIZED seconds (issue #255): the raw sum is divided by
 * the runner's speed factor, taken from the reference workload the job timed
 * before and after the probe (`measure-reference.mjs`). The same 592 faults cost
 * 2876-4159 s raw on four CI runs. A missing or absurd reference fails the
 * check; it never falls back to raw seconds.
 *
 * usage: check-cost-budget.mjs <evidence.json> [previous-evidence.json]
 *          --reference-before <file> --reference-after <file>
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { costReport, checkCostBudget, renderCostBudget, referenceFrom } from '../../src/probe/cost.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { values, positionals: [evidencePath, previousPath] } = parseArgs({
  allowPositionals: true,
  options: { 'reference-before': { type: 'string' }, 'reference-after': { type: 'string' } },
});
if (!evidencePath) {
  console.error('usage: check-cost-budget.mjs <evidence.json> [previous-evidence.json] --reference-before <file> --reference-after <file>');
  process.exit(2);
}

const read = (p) => JSON.parse(readFileSync(resolve(p), 'utf8'));
// An unreadable measurement is an absent one: the decision then fails closed as
// "reference missing", which names the problem, instead of crashing without it.
const tryRead = (p) => {
  try {
    return p ? read(p) : undefined;
  } catch {
    return undefined;
  }
};
const budget = read(join(ROOT, 'testguard.cost-budget.json'));

// A previous run is informational only. Its absence must never fail the check:
// the first run on a branch, or a cold cache, has nothing to compare against.
let previousMs;
if (previousPath) {
  try {
    previousMs = costReport(read(previousPath).records).totalMs;
  } catch {
    previousMs = undefined;
  }
}

const report = costReport(read(evidencePath).records);
const decision = checkCostBudget(report, {
  budgetSeconds: budget.seconds,
  perClaimSeconds: budget.perClaimSeconds,
  previousMs,
  reference: referenceFrom({ before: tryRead(values['reference-before']), after: tryRead(values['reference-after']), budget: budget.reference }),
});
const text = renderCostBudget(decision);
console.log(text);
// One machine-readable line, so the figures a ceiling is derived from can be
// read back out of a log without parsing prose.
console.log(`cost-measurement ${JSON.stringify({
  rawSeconds: Math.round(decision.rawMs / 100) / 10,
  ...(decision.reference ? { referenceBeforeMs: decision.reference.beforeMs, referenceAfterMs: decision.reference.afterMs, speedFactor: decision.reference.speedFactor, factorBasis: decision.reference.factorBasis } : {}),
  normalizedSeconds: Math.round(decision.totalMs / 100) / 10,
  basis: decision.basis,
  faults: report.records,
  reusedRecords: report.reusedRecords,
  ok: decision.ok,
  failures: decision.failures,
})}`);

// The gate's own history is the argument for writing this where it is seen:
// the run went 9.6 -> 23.6 minutes across one merged pull request and nothing
// said a word, because --cost only ever printed into a log nobody opens while
// it is passing. A new claim that quietly costs 51 s is the same failure one
// size down. A job summary is read without opening anything, so the number is
// in front of a reviewer while the change is still a change.
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = (report.claims ?? []).slice(0, 10)
    .map((c) => `| \`${c.claimId}\` | ${(c.ms / 1000).toFixed(1)}s | ${c.runs} |`)
    .join('\n');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `## Self-probe cost \u2014 ${decision.ok ? 'within budget' : 'FAILED'}`,
    '',
    '```',
    text,
    '```',
    '',
    '<details><summary>Most expensive claims</summary>',
    '',
    '| claim | cost | runs |',
    '| --- | ---: | ---: |',
    rows,
    '',
    'A claim pays for every test in the file it names, so the fix for an expensive',
    'claim is usually a cheaper defender rather than a bigger budget.',
    '</details>',
    '',
  ].join('\n'));
}

if (!decision.ok) {
  console.log(`::error::${text.split('\n')[0]}`);
  process.exit(1);
}
