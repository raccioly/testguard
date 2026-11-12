/**
 * The per-claim answer a caller reads from `probe --json`: one entry per
 * claim the invocation measured, keyed by claim id, never by position.
 *
 * Pure. The rule is the one `spec/GATE-SEMANTICS.md` states, in the order it
 * states it, and it rounds toward unproven:
 *
 *   1. a fault that survived or had no defender → `unproven`, whatever else
 *      happened to the claim's other faults;
 *   2. otherwise every fault killed, and at least one fault → `proven`;
 *   3. anything else (unverifiable, timeout, fault-invalid, flaky-defender,
 *      or no fault measured at all) → `could-not-verify`.
 *
 * `could-not-verify` is not a pass and not a finding about the code: the
 * measurement did not happen. It is its own word so a caller can retry or
 * repair the claim instead of writing a test for a fault nobody ran.
 */

/** Verdict → the counter it increments. `faults` counts verdicts, so the keys are the closed verdict set. */
export const VERDICT_COUNTERS = Object.freeze({
  killed: 'killed',
  survived: 'survived',
  nocover: 'nocover',
  unverifiable: 'unverifiable',
  'fault-invalid': 'faultInvalid',
  timeout: 'timeout',
  'flaky-defender': 'flakyDefender',
});

const emptyCounts = () => ({ total: 0, killed: 0, survived: 0, nocover: 0, unverifiable: 0, faultInvalid: 0, timeout: 0, flakyDefender: 0 });

/** The result word for a set of fault counts. */
export function claimResult(faults) {
  if (faults.survived > 0 || faults.nocover > 0) return 'unproven';
  if (faults.total >= 1 && faults.killed === faults.total) return 'proven';
  return 'could-not-verify';
}

/**
 * @param {Array<{claim: {id: string}, subject: {id: string}, verdict: string, detail?: {reason?: string}}>} records
 * @returns {Array<{id: string, result: string, faults: object, reasons: Array<{faultId: string, verdict: string, reason?: string}>}>}
 *   in the order each claim first appears in `records`.
 */
export function claimResults(records) {
  const byClaim = new Map();
  for (let record of records) {
    // A record a converging run kept stale (#293) says nothing about this
    // tree: it is counted as unverifiable, reason inputs-changed, whatever
    // verdict it carries, so its claim can never read proven from it.
    if (record.carried === 'inputs-changed') record = { ...record, verdict: 'unverifiable', detail: { ...record.detail, reason: 'inputs-changed' } };
    const counter = VERDICT_COUNTERS[record.verdict];
    // A verdict outside the closed set is a defect upstream; counting it as a
    // kill would be the optimistic reading, so it is counted as nothing and
    // the claim cannot reach `proven` (killed !== total).
    const entry = byClaim.get(record.claim.id) ?? { id: record.claim.id, faults: emptyCounts(), reasons: [] };
    entry.faults.total += 1;
    if (counter) entry.faults[counter] += 1;
    if (record.verdict !== 'killed') {
      entry.reasons.push({ faultId: record.subject.id, verdict: record.verdict, ...(record.detail?.reason ? { reason: record.detail.reason } : {}) });
    }
    byClaim.set(record.claim.id, entry);
  }
  return [...byClaim.values()].map((entry) => ({ id: entry.id, result: claimResult(entry.faults), faults: entry.faults, reasons: entry.reasons }));
}
