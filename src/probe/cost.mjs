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
 * ATTRIBUTION, HONESTLY. Runs execute a fault's selected defender set together,
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
      const e = by.get(file) ?? { file, ms: 0, runs: 0, claims: new Set(), faults: new Set() };
      e.ms += c.ms;
      e.runs += c.runs;
      e.claims.add(r.claim.id);
      e.faults.add(`${r.claim.id}/${r.subject.id}`);
      by.set(file, e);
    }
  }
  return [...by.values()]
    .map((e) => ({ ...e, claims: [...e.claims].sort(), faults: [...e.faults].sort() }))
    .sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file));
}

/**
 * The whole cost model for one evidence document.
 *
 * `sharedDefenders` is the actionable part: a file named by more than one
 * fault identity, including siblings within one claim. Splitting the
 * behaviour it defends into a unit test that runs in milliseconds is what
 * turns a twenty-four-minute gate into a one-minute one, and until a report
 * names the file nobody knows which test to split.
 */
export function costReport(records, { run } = {}) {
  const claims = claimCosts(records);
  const defenders = defenderCosts(records);
  return {
    ...(run?.measurements ? { measurements: { ...run.measurements } } : {}),
    totalMs: claims.reduce((a, c) => a + c.ms, 0),
    totalRuns: claims.reduce((a, c) => a + c.runs, 0),
    reusedRecords: records.filter((r) => r.reusedFrom).length,
    records: records.length,
    claims,
    faults: records.map((r) => ({ claimId: r.claim.id, faultId: r.subject.id, ...recordCost(r), defenders: [...(r.defenders?.resolved ?? [])], ...(r.defenders?.selectionSource ? { selectionSource: r.defenders.selectionSource } : {}) }))
      .sort((a, b) => b.ms - a.ms || a.claimId.localeCompare(b.claimId) || a.faultId.localeCompare(b.faultId)),
    defenders,
    sharedDefenders: defenders.filter((d) => d.faults.length > 1),
  };
}

// Measured durations are performance.now() differences, so they are fractional:
// round before choosing the unit, or 659.1493330000001ms prints verbatim and
// 999.6 prints as "1000ms".
const secs = (ms) => {
  const whole = Math.round(ms);
  return whole >= 10_000 ? `${Math.round(ms / 1000)}s` : whole >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${whole}ms`;
};
/** Exported so a caller can format a duration the same way the report does. */
export const formatMs = secs;

/**
 * The cost report as text. `limit` caps each list; the totals always describe
 * everything, so a truncated list never misrepresents the whole.
 */
export function renderCost(report, { limit = 10 } = {}) {
  const out = [];
  if (report.measurements) {
    const m = report.measurements;
    out.push(`actual elapsed ${secs(m.elapsedMs)}; fresh runners ${secs(m.runnerMs)} across ${m.runnerInvocations} invocations${m.reuseBaselineRuns ? ` (${m.reuseBaselineRuns} live baseline run${m.reuseBaselineRuns === 1 ? '' : 's'} licensing reuse)` : ''}; setup/discovery/other overhead ${secs(m.overheadMs)}`);
  }
  if (!report.records) return 'no evidence records — run `testguard probe` first; cost is read back from the runs it records.';
  out.push(`${report.records} fault record${report.records === 1 ? '' : 's'} cost ${secs(report.totalMs)} across ${report.totalRuns} defender runs${report.reusedRecords ? ` (${report.reusedRecords} reused; their runs are what they cost when reuse does not apply)` : ''}.`);
  out.push('');
  out.push('most expensive claims');
  for (const c of report.claims.slice(0, limit)) {
    out.push(`  ${secs(c.ms).padStart(7)}  ${c.claimId.padEnd(34)} ${c.faults} fault${c.faults === 1 ? ' ' : 's'} · ${c.runs} runs${c.reused ? ` · ${c.reused} reused` : ''}`);
  }
  if (report.claims.length > limit) out.push(`  … ${report.claims.length - limit} more`);
  if (report.faults?.length) {
    out.push('', 'most expensive faults');
    for (const f of report.faults.slice(0, limit)) out.push(`  ${secs(f.ms).padStart(7)}  ${f.claimId}/${f.faultId} · ${f.runs} runs${f.selectionSource ? ` · ${f.selectionSource}` : ''} · ${f.defenders.join(', ') || 'no defenders'}`);
    if (report.faults.length > limit) out.push(`  … ${report.faults.length - limit} more`);
  }
  out.push('');
  out.push('defender files, by the time of the runs that included them');
  out.push('  (a fault runs its selected defender set at once, so these overlap and do not sum to the total)');
  for (const d of report.defenders.slice(0, limit)) {
    out.push(`  ${secs(d.ms).padStart(7)}  ${d.file.padEnd(44)} ${d.claims.length} claim${d.claims.length === 1 ? '' : 's'}`);
  }
  if (report.defenders.length > limit) out.push(`  … ${report.defenders.length - limit} more`);
  if (report.sharedDefenders.length) {
    out.push('');
    out.push('shared defenders — each fault selects the file; durations include recorded baseline sharing');
    for (const d of report.sharedDefenders.slice(0, limit)) {
      out.push(`  ${secs(d.ms).padStart(7)}  ${d.file}`);
      out.push(`           named by ${d.faults.join(', ')}`);
    }
    out.push('');
    out.push('  To make a probe cheaper, split the behaviour a shared defender proves into a');
    out.push('  test that does not need the expensive setup, and point the claim at that.');
  }
  return out.join('\n');
}

/** The speed factor a reference may take before the run is rejected as absurd. */
export const REFERENCE_FACTOR_RANGE = Object.freeze([0.5, 2.5]);
/** Largest ratio between the before and after reference medians before the run is low confidence. */
export const REFERENCE_MAX_DRIFT = 1.5;

const positive = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;

/** Median of a batch; the mean of the middle two when the batch is even. Never reorders its input. */
export function median(xs) {
  if (!Array.isArray(xs) || xs.length === 0 || !xs.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new TypeError('median: a non-empty array of finite numbers is required');
  }
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A cost in a runner-independent unit: what it would have measured on the baseline runner. */
export function normalize(value, speedFactor) {
  if (!positive(speedFactor)) throw new TypeError('normalize: speedFactor must be a positive finite number');
  return value / speedFactor;
}

/**
 * What a reference measurement says about the runner (issue #255).
 *
 * The same 592 faults cost 2876 s, 2901 s, 3366 s and 4159 s on four CI runs,
 * so a summed-seconds ceiling either flakes on a slow runner or hides growth on
 * a fast one. A fixed workload is timed in the same job immediately before and
 * after the probe: `beforeMs` and `afterMs` are the medians of those two
 * batches, `baselineMs` is the median recorded in the budget file. The speed
 * factor is the mean of the two over the baseline, so a runner that sped up or
 * slowed down mid-probe is charged for the average it ran at.
 *
 * Fails closed. A missing or non-positive number is `missing`, never a factor of
 * 1; a factor outside the range is `out-of-range`, because the workload no
 * longer measures the same thing as the probe. If the two batches differ by more
 * than `maxDrift`, or verdicts were reused from another runner, the factor is
 * `lowConfidence`: usable for a pass, never for excusing a run over the ceiling.
 */
export function assessReference(reference, { reusedRecords = 0 } = {}) {
  const { beforeMs, afterMs, baselineMs, factorRange = REFERENCE_FACTOR_RANGE, maxDrift = REFERENCE_MAX_DRIFT } = reference ?? {};
  if (!positive(beforeMs) || !positive(afterMs) || !positive(baselineMs)) return { status: 'missing', beforeMs, afterMs, baselineMs };
  const speedFactor = (beforeMs + afterMs) / 2 / baselineMs;
  const drift = Math.max(beforeMs, afterMs) / Math.min(beforeMs, afterMs);
  const lowConfidenceReasons = [
    ...(drift > maxDrift ? ['drift'] : []),
    ...(reusedRecords > 0 ? ['reused-records'] : []),
  ];
  return {
    status: speedFactor < factorRange[0] || speedFactor > factorRange[1] ? 'out-of-range' : 'ok',
    beforeMs, afterMs, baselineMs, speedFactor, drift, maxDrift, factorRange,
    lowConfidence: lowConfidenceReasons.length > 0,
    lowConfidenceReasons,
  };
}

/**
 * The `reference` argument of `checkCostBudget`, from the two measurement files
 * the job wrote and the `reference` block of the budget file. A measurement of
 * a different workload than the baseline was taken with is not comparable, so
 * it is dropped, which `assessReference` then reports as missing.
 */
export function referenceFrom({ before, after, budget } = {}) {
  const same = (m) => (m && budget && m.workload === budget.workload ? m.medianMs : undefined);
  return {
    beforeMs: same(before),
    afterMs: same(after),
    baselineMs: budget?.baselineMs,
    ...(budget?.factorRange ? { factorRange: budget.factorRange } : {}),
    ...(budget?.maxDrift ? { maxDrift: budget.maxDrift } : {}),
  };
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
 * `reference` makes the comparison runner-independent (see `assessReference`):
 * `undefined` compares raw seconds and says so; anything else, `null` included,
 * is a request to normalize, and a reference that cannot be used fails the gate
 * rather than falling back to raw seconds. Both ceilings are in normalized
 * seconds then: the time the work would take on the baseline runner.
 *
 * Pure. Reads a report, returns a decision; the caller owns exit codes and I/O.
 */
export function checkCostBudget(report, { budgetSeconds, perClaimSeconds, previousMs, worst = 5, reference } = {}) {
  if (typeof budgetSeconds !== 'number' || !Number.isFinite(budgetSeconds) || budgetSeconds <= 0) {
    throw new TypeError('checkCostBudget: budgetSeconds must be a positive number');
  }
  const budgetMs = budgetSeconds * 1000;
  const rawMs = report.totalMs ?? 0;
  const assessment = reference === undefined ? undefined : assessReference(reference, { reusedRecords: report.reusedRecords ?? 0 });
  const factor = assessment?.status === 'ok' ? assessment.speedFactor : 1;
  const basis = assessment === undefined ? 'raw' : assessment.status === 'ok' ? 'normalized' : 'unnormalized';
  const totalMs = normalize(rawMs, factor);

  // ── Why a SECOND ceiling, on the claim. ──
  // The total alone is a treadmill: claims should grow forever, so it can only
  // ever be raised, and a number that always goes up stops being read. A
  // per-FAULT average is worse — the regression that prompted this budget
  // raised the fault count 59 -> 91 while per-fault cost barely moved, so an
  // average would have reported everything fine.
  //
  // The measured pathology is per-CLAIM, and it is a claim naming an expensive
  // SHARED defender: a claim pays for every test in the file it names, so
  // TG-ADMIT-NEEDS-ALL-KILLED costs 67 s for ONE fault. A new calibration
  // claim landed at 51 s for two faults purely by being written into
  // replay.test.mjs instead of calibration.test.mjs; re-pointing it took it to
  // 4.9 s. The total absorbed that silently. This does not.
  //
  // So the rule is "no new claim may be worse than the worst we already have",
  // which stays meaningful as claims are added and tightens as they get cheaper.
  const perClaimMs = typeof perClaimSeconds === 'number' && perClaimSeconds > 0 ? perClaimSeconds * 1000 : undefined;
  // `rawMs` appears only when a reference was asked for: without one, `ms` already is the raw figure.
  const inUnits = (c) => ({ id: c.claimId, ms: normalize(c.ms, factor), ...(assessment === undefined ? {} : { rawMs: c.ms }), runs: c.runs });
  const overPerClaim = perClaimMs === undefined ? [] : (report.claims ?? [])
    .map(inUnits)
    .filter((c) => c.ms > perClaimMs);

  const overCeiling = totalMs > budgetMs || overPerClaim.length > 0;
  const failures = [
    ...(assessment?.status === 'missing' ? ['reference-missing'] : []),
    ...(assessment?.status === 'out-of-range' ? ['reference-out-of-range'] : []),
    ...(totalMs > budgetMs ? ['over-budget'] : []),
    ...(overPerClaim.length > 0 ? ['per-claim-over-ceiling'] : []),
    ...(assessment?.status === 'ok' && assessment.lowConfidence && overCeiling ? ['low-confidence-over-ceiling'] : []),
  ];

  return {
    ok: failures.length === 0,
    failures,
    basis,
    rawMs,
    ...(assessment === undefined ? {} : { reference: assessment }),
    totalMs,
    budgetMs,
    overByMs: Math.max(0, totalMs - budgetMs),
    headroomMs: Math.max(0, budgetMs - totalMs),
    ...(perClaimMs === undefined ? {} : { perClaimMs, overPerClaim }),
    ...(typeof previousMs === 'number' ? { previousMs, deltaMs: rawMs - previousMs } : {}),
    // Named so a failure opens with which claims to look at, not just a number.
    // claimCosts emits `claimId`; reading `id` here printed "undefined" for every
    // claim the first time the budget fired, and the test had fed the wished-for shape.
    worst: (report.claims ?? []).slice(0, worst).map(inUnits),
  };
}

/** The reference measurement and what it did to the total, as the lines the log always carries. */
function renderReference(d) {
  const r = d.reference;
  if (!r) return [`basis: raw seconds, not normalized by runner speed (raw ${secs(d.rawMs)}).`];
  if (r.status === 'missing') {
    const show = (x) => (x === undefined ? 'absent' : String(x));
    return [`reference: no usable measurement (before ${show(r.beforeMs)}, after ${show(r.afterMs)}, baseline ${show(r.baselineMs)}); raw ${secs(d.rawMs)} was not compared with the ceiling.`];
  }
  const out = [`raw ${secs(d.rawMs)}; reference before ${secs(r.beforeMs)}, after ${secs(r.afterMs)}, baseline ${secs(r.baselineMs)} (drift ${r.drift.toFixed(2)}x); speed factor ${r.speedFactor.toFixed(2)}${r.status === 'ok' ? `; normalized ${secs(d.totalMs)}.` : '; not applied.'}`];
  if (r.lowConfidence) {
    const why = r.lowConfidenceReasons.map((x) => (x === 'drift'
      ? `the runner's speed moved by ${r.drift.toFixed(2)}x during the probe (limit ${r.maxDrift}x)`
      : 'verdicts were reused from runs on other runners')).join('; ');
    out.push(`low confidence: ${why}.`);
  }
  return out;
}

/** The budget decision as text, for a CI log that someone reads only when it fails. */
export function renderCostBudget(d) {
  const out = [];
  const delta = typeof d.deltaMs === 'number'
    ? ` (${d.deltaMs >= 0 ? '+' : ''}${secs(Math.abs(d.deltaMs))} raw against the previous run's ${secs(d.previousMs)})`
    : '';
  const overTotal = d.totalMs > d.budgetMs;
  const unit = d.basis === 'normalized' ? 'normalized ' : '';
  if (d.failures.includes('reference-missing')) {
    out.push('COST REFERENCE MISSING: the runner-speed measurement is absent or not a positive number, so the cost cannot be compared with its ceiling. Not falling back to raw seconds.');
  } else if (d.failures.includes('reference-out-of-range')) {
    out.push(`COST REFERENCE OUT OF RANGE: speed factor ${d.reference.speedFactor.toFixed(2)} is outside ${d.reference.factorRange[0]}–${d.reference.factorRange[1]}; the reference no longer measures what the probe does, or the runner is not comparable. Not falling back to raw seconds.`);
  } else if (overTotal) {
    out.push(`COST BUDGET EXCEEDED: ${unit}${secs(d.totalMs)} against a ${secs(d.budgetMs)} budget, over by ${secs(d.overByMs)}${delta}.`);
  } else {
    out.push(`cost ${unit}${secs(d.totalMs)} of a ${secs(d.budgetMs)} budget — ${secs(d.headroomMs)} to spare${delta}.`);
  }
  out.push(...renderReference(d));
  if (d.failures.includes('low-confidence-over-ceiling')) {
    out.push('LOW-CONFIDENCE RUN OVER THE CEILING: the runner-speed correction cannot be trusted here, so it does not excuse the overage. Re-run the job; if it repeats, the suite grew.');
  }

  // A per-claim breach is its own finding and names its own remedy: the claim
  // is not too big, it is pointed at too expensive a defender file.
  if (d.overPerClaim?.length) {
    out.push('');
    out.push(`PER-CLAIM BUDGET EXCEEDED: ${d.overPerClaim.length} claim${d.overPerClaim.length === 1 ? '' : 's'} over the ${secs(d.perClaimMs)} per-claim ceiling.`);
    for (const c of d.overPerClaim) out.push(`  ${secs(c.ms).padStart(7)}  ${c.id}  (${c.runs} runs${d.basis === 'normalized' ? `, raw ${secs(c.rawMs)}` : ''})`);
    out.push('');
    out.push('A claim pays for every test in the file it names. Point it at a test that');
    out.push('does not need the expensive setup, re-probe to confirm the fault still dies,');
    out.push('and only then raise the ceiling if it is still over.');
  }

  if (overTotal && d.worst.length) {
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
