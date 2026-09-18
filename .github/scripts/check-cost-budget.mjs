#!/usr/bin/env node
/**
 * Fail CI when the self-probe gate outgrows its budget.
 *
 * The decision lives in `src/probe/cost.mjs` as a pure function, unit-tested
 * and covered by a self-claim; this script is only wiring — read the evidence,
 * read the budget, print, choose an exit code.
 *
 * usage: check-cost-budget.mjs <evidence.json> [previous-evidence.json]
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costReport, checkCostBudget, renderCostBudget } from '../../src/probe/cost.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [evidencePath, previousPath] = process.argv.slice(2);
if (!evidencePath) {
  console.error('usage: check-cost-budget.mjs <evidence.json> [previous-evidence.json]');
  process.exit(2);
}

const read = (p) => JSON.parse(readFileSync(resolve(p), 'utf8'));
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
});
const text = renderCostBudget(decision);
console.log(text);

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
    `## Self-probe cost \u2014 ${decision.ok ? 'within budget' : 'OVER BUDGET'}`,
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
