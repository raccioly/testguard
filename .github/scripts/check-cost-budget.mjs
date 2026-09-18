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
import { readFileSync } from 'node:fs';
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

const decision = checkCostBudget(costReport(read(evidencePath).records), { budgetSeconds: budget.seconds, previousMs });
const text = renderCostBudget(decision);
console.log(text);
if (!decision.ok) {
  console.log(`::error::${text.split('\n')[0]}`);
  process.exit(1);
}
