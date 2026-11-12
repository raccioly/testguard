import { recordedOriginSummary } from '../../spec/lib/origins.mjs';

/**
 * Convergence (#293): a change- or claim-scoped probe whose selection is
 * determined updates the canonical evidence instead of leaving it stale.
 *
 * The probe measures the selected claims and decides, in the tree it probed,
 * whether each unselected fault's earlier record still has the inputs it was
 * measured with (`carryOne` in probe.mjs: the input half of the reuse rule,
 * no live baseline). This module is the pure rest: may this invocation
 * converge at all, and the merged document.
 *
 * A carried record (`carried: "inputs-match"`) vouches that its recorded
 * inputs equal the tree this run probed, under the same instrument. It does
 * not vouch for the environment (installed packages, the interpreter, data a
 * test reads): no defender ran for it in this run. The full probe stays the
 * periodic re-verification. A record whose inputs no longer match is kept as
 * it was (`carried: "inputs-changed"`), so `status` still names it stale with
 * the verdict it had, and `baseline` refuses the document. A carried record
 * never changes verdict.
 */

/** Values for a record's `carried`. */
export const CARRIED = Object.freeze({ match: 'inputs-match', changed: 'inputs-changed' });

/**
 * Whether this invocation may update the canonical evidence, decided from
 * the request alone (before the probe runs). The run-level reuse rule, the
 * budget and a concurrent writer are checked after it.
 */
export function convergeRequest({ scoped, provisional, refExplicit, noReuse, out, canonical, canonicalExists }) {
  if (!scoped) return { converge: false };
  if (provisional) return { converge: false, reason: 'the run is provisional (--confirm below 3)' };
  if (refExplicit) return { converge: false, reason: '--ref probes another commit than the canonical evidence describes' };
  if (noReuse) return { converge: false, reason: '--no-reuse disables carrying records forward' };
  if (out !== undefined && out !== canonical) return { converge: false, reason: `--out names ${out}` };
  if (!canonicalExists) return { converge: false, reason: 'there is no canonical evidence yet (run testguard probe once)' };
  return { converge: true };
}

/** The `run.reuse` tally of a document's records. */
export function reuseTally(records) {
  const reused = records.filter((r) => r.reusedFrom).length;
  const carried = records.filter((r) => r.carried === CARRIED.match).length;
  const stale = records.filter((r) => r.carried === CARRIED.changed).length;
  return { reused, measured: records.length - reused, ...(carried || stale ? { carried, stale } : {}) };
}

/**
 * The canonical document after a converging run: in claims-file order, the
 * records this run measured, then for every other fault the canonical record
 * marked with what the probe decided. A fault with no earlier record stays
 * absent (status says it was never probed). Policies evaluated over another
 * set of records are not carried; the caller evaluates its own.
 */
export function mergeEvidence({ measured, canonical, decisions, claims, scope }) {
  const key = (r) => `${r.claim.id}/${r.subject.id}`;
  const fresh = new Map(measured.records.map((r) => [key(r), r]));
  const earlier = new Map(canonical.records.map((r) => [key(r), r]));
  const records = [];
  for (const claim of claims.claims) {
    for (const fault of claim.faults) {
      const id = `${claim.id}/${fault.id}`;
      if (fresh.has(id)) { records.push(fresh.get(id)); continue; }
      const decision = decisions.get(id);
      const record = earlier.get(id);
      if (!record || !decision) continue;
      records.push({ ...record, reusedFrom: record.reusedFrom ?? canonical.run.id, carried: decision });
    }
  }
  const { originPolicy, assertionPolicy, ...rest } = measured;
  return {
    ...rest,
    run: { ...measured.run, reuse: reuseTally(records), scope: { ...scope, carriedFrom: canonical.run.id } },
    records,
    origins: recordedOriginSummary(records),
  };
}

/** Faults kept with inputs that no longer match: what `baseline` refuses and `probe` names. */
export const staleCarried = (doc) => doc.records.filter((r) => r.carried === CARRIED.changed).map((r) => `${r.claim.id}/${r.subject.id}`);
