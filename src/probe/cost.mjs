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
