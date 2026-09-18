/**
 * What a probe costs, derived from evidence that already exists (issue #67).
 *
 * A probe's wall clock is not a function of how many claims there are. It is
 * `(baseline runs + faults × confirm runs) × the cost of the claim's defender
 * SET`, per claim. One slow acceptance test named as a defender by five claims
 * is therefore paid for thirty times, and nothing in the output says so — the
 * only symptom is that the gate takes twenty-four minutes and nobody knows
 * which line to blame.
 *
 * Every number here is read back out of `durationMs` on the runs the probe
 * already recorded. Nothing re-measures, nothing spawns, nothing guesses: a
 * cost report costs the price of reading one JSON file.
 *
 * ATTRIBUTION, HONESTLY. Runs execute a claim's whole defender set together,
 * so the runner never says how much of a run belonged to which file. Per-file
 * `ms` is therefore the time of every run that *included* that file: an upper
 * bound on what removing it could save, and, when a claim names several
 * defenders, a number that overlaps with its siblings. The per-file figures do
 * not sum to the total, by construction. `totalMs` is the only additive one.
 */

/** Every run a record paid for, in the order the probe made them. */
export const runsOf = (record) => [
  ...(record.detail?.baselineRuns ?? []),
  ...(record.detail?.probeRuns ?? []),
  ...(record.detail?.escalationRuns ?? []),
];

/**
 * What one record cost. A reused record reports the duration of the runs it
 * reused, which is the right number for planning — it is what the record costs
 * whenever reuse does not apply — and `reused` marks it so a reader does not
 * read it as wall clock just spent.
 */
export function recordCost(record) {
  const runs = runsOf(record);
  return {
    ms: runs.reduce((a, r) => a + (r.durationMs ?? 0), 0),
    runs: runs.length,
    reused: Boolean(record.reusedFrom),
  };
}

/** Per claim: what its faults cost in total, most expensive first. */
export function claimCosts(records) {
  const by = new Map();
  for (const r of records) {
    const c = recordCost(r);
    const e = by.get(r.claim.id) ?? { claimId: r.claim.id, ms: 0, runs: 0, faults: 0, reused: 0, defenders: new Set() };
    e.ms += c.ms;
    e.runs += c.runs;
    e.faults += 1;
    if (c.reused) e.reused += 1;
    for (const d of r.defenders?.resolved ?? []) e.defenders.add(d);
    by.set(r.claim.id, e);
  }
  return [...by.values()]
    .map((e) => ({ ...e, defenders: [...e.defenders].sort() }))
    .sort((a, b) => b.ms - a.ms || a.claimId.localeCompare(b.claimId));
}

/**
 * Per defender file: the time of every run that included it, and the claims
 * that named it. See the attribution note above — this is a ceiling, not a
 * share, and the figures overlap.
 */
export function defenderCosts(records) {
  const by = new Map();
  for (const r of records) {
    const c = recordCost(r);
    for (const file of r.defenders?.resolved ?? []) {
      const e = by.get(file) ?? { file, ms: 0, runs: 0, claims: new Set() };
      e.ms += c.ms;
      e.runs += c.runs;
      e.claims.add(r.claim.id);
      by.set(file, e);
    }
  }
  return [...by.values()]
    .map((e) => ({ ...e, claims: [...e.claims].sort() }))
    .sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file));
}

/**
 * The whole cost model for one evidence document.
 *
 * `sharedDefenders` is the actionable part: a file named by more than one
 * claim, whose cost is multiplied by every claim that names it. Splitting the
 * behaviour it defends into a unit test that runs in milliseconds is what
 * turns a twenty-four-minute gate into a one-minute one, and until a report
 * names the file nobody knows which test to split.
 */
export function costReport(records) {
  const claims = claimCosts(records);
  const defenders = defenderCosts(records);
  return {
    totalMs: claims.reduce((a, c) => a + c.ms, 0),
    totalRuns: claims.reduce((a, c) => a + c.runs, 0),
    reusedRecords: records.filter((r) => r.reusedFrom).length,
    records: records.length,
    claims,
    defenders,
    sharedDefenders: defenders.filter((d) => d.claims.length > 1),
  };
}

const secs = (ms) => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
/** Exported so a caller can format a duration the same way the report does. */
export const formatMs = secs;

/**
 * The cost report as text. `limit` caps each list; the totals always describe
 * everything, so a truncated list never misrepresents the whole.
 */
export function renderCost(report, { limit = 10 } = {}) {
  const out = [];
  if (!report.records) return 'no evidence records — run `testguard probe` first; cost is read back from the runs it records.';
  out.push(`${report.records} fault record${report.records === 1 ? '' : 's'} cost ${secs(report.totalMs)} across ${report.totalRuns} defender runs${report.reusedRecords ? ` (${report.reusedRecords} reused; their runs are what they cost when reuse does not apply)` : ''}.`);
  out.push('');
  out.push('most expensive claims');
  for (const c of report.claims.slice(0, limit)) {
    out.push(`  ${secs(c.ms).padStart(7)}  ${c.claimId.padEnd(34)} ${c.faults} fault${c.faults === 1 ? ' ' : 's'} · ${c.runs} runs${c.reused ? ` · ${c.reused} reused` : ''}`);
  }
  if (report.claims.length > limit) out.push(`  … ${report.claims.length - limit} more`);
  out.push('');
  out.push('defender files, by the time of the runs that included them');
  out.push('  (a claim runs its whole defender set at once, so these overlap and do not sum to the total)');
  for (const d of report.defenders.slice(0, limit)) {
    out.push(`  ${secs(d.ms).padStart(7)}  ${d.file.padEnd(44)} ${d.claims.length} claim${d.claims.length === 1 ? '' : 's'}`);
  }
  if (report.defenders.length > limit) out.push(`  … ${report.defenders.length - limit} more`);
  if (report.sharedDefenders.length) {
    out.push('');
    out.push('shared defenders — each claim pays the file\'s full cost again');
    for (const d of report.sharedDefenders.slice(0, limit)) {
      out.push(`  ${secs(d.ms).padStart(7)}  ${d.file}`);
      out.push(`           named by ${d.claims.join(', ')}`);
    }
    out.push('');
    out.push('  To make a probe cheaper, split the behaviour a shared defender proves into a');
    out.push('  test that does not need the expensive setup, and point the claim at that.');
  }
  return out.join('\n');
}

/**
 * Is this probe within its cost budget?
 *
 * The gate went from 9.6 minutes to 23.6 across one merged pull request, and
 * nothing said a word — `--cost` had been printing the number into every CI log
 * since the previous optimisation. A measurement nothing gates on is not a
 * check, which is the premise this whole tool rests on, applied to itself.
 *
 * Budget the TOTAL, never the per-fault average. The regression that prompted
 * this raised the fault count from 59 to 91 while per-fault cost barely moved,
 * so an average would have reported everything fine while the gate tripled.
 * Growth is legitimate; the point is that someone signs for it in a diff.
 *
 * `previousMs` is optional and only ever informational: "804s, budget 900s" is
 * a much weaker signal than "804s, was 780s", and the prior total is already in
 * the evidence CI restores for verdict reuse.
 *
 * Pure. Reads a report, returns a decision; the caller owns exit codes and I/O.
 */
export function checkCostBudget(report, { budgetSeconds, previousMs, worst = 5 } = {}) {
  if (typeof budgetSeconds !== 'number' || !Number.isFinite(budgetSeconds) || budgetSeconds <= 0) {
    throw new TypeError('checkCostBudget: budgetSeconds must be a positive number');
  }
  const budgetMs = budgetSeconds * 1000;
  const totalMs = report.totalMs ?? 0;
  return {
    ok: totalMs <= budgetMs,
    totalMs,
    budgetMs,
    overByMs: Math.max(0, totalMs - budgetMs),
    headroomMs: Math.max(0, budgetMs - totalMs),
    ...(typeof previousMs === 'number' ? { previousMs, deltaMs: totalMs - previousMs } : {}),
    // Named so a failure opens with which claims to look at, not just a number.
    // claimCosts emits `claimId`; reading `id` here printed "undefined" for every
    // claim the first time the budget fired, and the test had fed the wished-for shape.
    worst: (report.claims ?? []).slice(0, worst).map((c) => ({ id: c.claimId, ms: c.ms, runs: c.runs })),
  };
}

/** The budget decision as text, for a CI log that someone reads only when it fails. */
export function renderCostBudget(d) {
  const out = [];
  const delta = typeof d.deltaMs === 'number'
    ? ` (${d.deltaMs >= 0 ? '+' : ''}${secs(Math.abs(d.deltaMs))} against the previous run's ${secs(d.previousMs)})`
    : '';
  out.push(d.ok
    ? `cost ${secs(d.totalMs)} of a ${secs(d.budgetMs)} budget — ${secs(d.headroomMs)} to spare${delta}.`
    : `COST BUDGET EXCEEDED: ${secs(d.totalMs)} against a ${secs(d.budgetMs)} budget, over by ${secs(d.overByMs)}${delta}.`);
  if (!d.ok && d.worst.length) {
    out.push('');
    out.push('most expensive claims');
    for (const c of d.worst) out.push(`  ${secs(c.ms).padStart(7)}  ${c.id}  (${c.runs} runs)`);
    out.push('');
    out.push('Either move a claim onto a defender that does not need the expensive setup —');
    out.push('re-probing afterwards, never assuming — or raise the budget in a commit that');
    out.push('says why. Growth is allowed; going unnoticed is not.');
  }
  return out.join('\n');
}
