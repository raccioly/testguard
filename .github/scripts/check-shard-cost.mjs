#!/usr/bin/env node
/**
 * The cost gate for a sharded full self-probe.
 *
 * Each shard ran on its own runner and timed its own reference workload before
 * and after, so each shard's elapsed time is normalized by ITS speed factor
 * (src/probe/cost.mjs, the same function the unsharded gate uses). The ceiling
 * is on the SUM of those: total compute, so it does not depend on how many
 * shards there were. The slowest shard's normalized time is printed beside it:
 * that, plus the merge, is the wall time. Every per-shard failure of the
 * unsharded gate still fails (missing or absurd reference, another fault-worker
 * width, a claim over the per-claim ceiling); only the total is judged on the sum.
 *
 * A sharded run is a different CONFIGURATION from an unsharded one, exactly as
 * another fault-worker count is: its ceilings live in `budget.sharded`
 * ({ shards, seconds, slowestShardSeconds }) and the gate fails closed when the
 * run had another number of shards. Two numbers are bounded: the sum (total
 * compute) and the slowest shard's normalized time, which is what a person waits for.
 *
 *   usage: check-shard-cost.mjs <dir>     (<dir>/<shard>/{evidence,reference-before,reference-after}.json)
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { costReport, checkCostBudget, referenceFrom } from '../../src/probe/cost.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tryRead = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return undefined; } };

/** Pure: shard measurements in, a decision out. */
export function decideShardCost(shards, budget) {
  const cfg = budget.sharded;
  if (!cfg || !Number.isInteger(cfg.shards) || typeof cfg.seconds !== 'number' || typeof cfg.slowestShardSeconds !== 'number') {
    return { ok: false, failures: ['the cost budget has no `sharded` configuration (shards, seconds, slowestShardSeconds)'], rows: [], sumMs: 0, slowestMs: 0, budgetMs: 0, slowestBudgetMs: 0 };
  }
  const rows = shards.map((s) => {
    const report = costReport(s.evidence.records);
    const d = checkCostBudget(report, {
      budgetSeconds: 1e9, // the total is judged on the sum below, never per shard
      perClaimSeconds: budget.perClaimSeconds,
      elapsedMs: s.evidence.run?.measurements?.elapsedMs,
      faultWorkers: s.evidence.run?.faultWorkers ?? 1,
      budgetFaultWorkers: budget.faultWorkers,
      unit: budget.unit,
      reference: referenceFrom({ before: s.before, after: s.after, budget: budget.reference }),
    });
    return { name: s.name, faults: report.records, rawMs: d.rawMs, normalizedMs: d.totalMs, failures: d.failures.filter((f) => f !== 'over-budget'), worst: d.worst, basis: d.basis };
  });
  const sumMs = rows.reduce((a, r) => a + r.normalizedMs, 0);
  const slowestMs = rows.reduce((a, r) => Math.max(a, r.normalizedMs), 0);
  const failures = rows.flatMap((r) => r.failures.map((f) => `${r.name}: ${f}`));
  if (rows.length === 0) failures.push('no shard evidence');
  if (rows.length !== cfg.shards) failures.push(`shards-mismatch: ${rows.length} shards ran, the ceilings are for ${cfg.shards}`);
  else {
    if (sumMs > cfg.seconds * 1000) failures.push(`over-budget: the shards' normalized compute ${(sumMs / 1000).toFixed(0)}s is over the ${cfg.seconds}s ceiling`);
    if (slowestMs > cfg.slowestShardSeconds * 1000) failures.push(`over-wall-budget: the slowest shard's normalized ${(slowestMs / 1000).toFixed(0)}s is over its ${cfg.slowestShardSeconds}s ceiling`);
  }
  return { ok: failures.length === 0, failures, rows, sumMs, slowestMs, budgetMs: cfg.seconds * 1000, slowestBudgetMs: cfg.slowestShardSeconds * 1000 };
}

export function render(d) {
  const s = (ms) => `${(ms / 1000).toFixed(0)}s`;
  return [
    `${d.ok ? 'COST WITHIN BUDGET' : 'COST BUDGET EXCEEDED'} (sharded): total normalized compute ${s(d.sumMs)} of ${s(d.budgetMs)} across ${d.rows.length} shards; slowest shard ${s(d.slowestMs)} of ${s(d.slowestBudgetMs)} (the wall time, before the merge).`,
    ...d.rows.map((r) => `  ${r.name}: ${r.faults} faults, raw ${s(r.rawMs)}, normalized ${s(r.normalizedMs)} (${r.basis})${r.failures.length ? ` — ${r.failures.join(', ')}` : ''}`),
    ...d.failures.map((f) => `  FAIL ${f}`),
  ].join('\n');
}

export function main(argv) {
  const [dir] = argv;
  if (!dir) { console.error('usage: check-shard-cost.mjs <dir>'); return 2; }
  const budget = JSON.parse(readFileSync(join(ROOT, 'testguard.cost-budget.json'), 'utf8'));
  const shards = readdirSync(resolve(dir)).sort().map((n) => join(resolve(dir), n)).filter((p) => statSync(p).isDirectory() && existsSync(join(p, 'evidence.json')))
    .map((p) => ({ name: p.split('/').pop(), evidence: JSON.parse(readFileSync(join(p, 'evidence.json'), 'utf8')), before: tryRead(join(p, 'reference-before.json')), after: tryRead(join(p, 'reference-after.json')) }));
  const d = decideShardCost(shards, budget);
  const text = render(d);
  console.log(text);
  console.log(`cost-measurement ${JSON.stringify({ sharded: true, shards: d.rows.length, sumNormalizedSeconds: Math.round(d.sumMs / 100) / 10, slowestShardNormalizedSeconds: Math.round(d.slowestMs / 100) / 10, shardWalls: d.rows.map((r) => Math.round(r.normalizedMs / 100) / 10), ok: d.ok, failures: d.failures })}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Sharded self-probe cost — ${d.ok ? 'within budget' : 'FAILED'}\n\n\`\`\`\n${text}\n\`\`\`\n`);
  if (!d.ok) { console.log(`::error::${text.split('\n')[0]}`); return 1; }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
