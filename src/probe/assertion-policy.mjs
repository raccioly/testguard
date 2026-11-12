/**
 * `--require-assertion-kill`: a gate's way of asking for more than "the suite
 * went red". Pure and small on purpose; it adds no verdict. A `killed` record
 * keeps its verdict, and the policy names the kills that were made only by an
 * exception the fault provoked (the suite reached the code, but nothing
 * checked a value).
 *
 * A killed record with no recorded `killKind` (evidence written before the
 * field existed, reused) fails too: unknown rounds toward unproven.
 * `mixed` passes: at least one run saw an assertion reject the fault.
 */

/** Admit the option before any work: valid on probe and admit only. */
export function assertionPolicyRequest(values, command) {
  if (!values['require-assertion-kill']) return false;
  if (command !== 'probe' && command !== 'admit') throw new TypeError('--require-assertion-kill is only valid on probe and admit');
  return true;
}

/** A killed record whose kill is not backed by an assertion in any run. */
export const isWeakKill = (record) => record.verdict === 'killed' && record.detail?.killKind !== 'assertion' && record.detail?.killKind !== 'mixed';

export function evaluateAssertionPolicy(records) {
  // A record a converging run kept stale (#293) is not current evidence: the
  // policy cannot pass over it, and cannot judge it either. Unavailable.
  const staleRecords = records.filter((r) => r.carried === 'inputs-changed').map((r) => ({ claimId: r.claim.id, faultId: r.subject.id }))
    .sort((a, b) => a.claimId.localeCompare(b.claimId) || a.faultId.localeCompare(b.faultId));
  const current = records.filter((r) => r.carried !== 'inputs-changed');
  const exceptionOnlyKills = current.filter(isWeakKill)
    .map((r) => ({ claimId: r.claim.id, faultId: r.subject.id, ...(r.detail.killKindReason ? { reason: r.detail.killKindReason } : {}) }))
    .sort((a, b) => a.claimId.localeCompare(b.claimId) || a.faultId.localeCompare(b.faultId));
  if (staleRecords.length) return { state: 'unavailable', exceptionOnlyKills, staleRecords };
  return { state: exceptionOnlyKills.length ? 'failed' : 'passed', exceptionOnlyKills };
}

/**
 * The two answers a converging scoped run gives (#293 review): the document
 * it writes holds the policy over every record in it (unavailable while one
 * is kept stale), and the run's own exit and line judge what it measured,
 * as a scoped run always has: a stale record outside the selection is not
 * this run's to judge. `unjudged` counts those records.
 */
export function scopedAssertionPolicy({ measured, written, converged }) {
  const document = evaluateAssertionPolicy(written);
  if (!converged) return { document, run: document, unjudged: 0 };
  return { document, run: evaluateAssertionPolicy(measured), unjudged: written.filter((r) => r.carried === 'inputs-changed').length };
}

export const renderAssertionPolicy = (policy) => policy.state === 'unavailable'
  ? `assertion policy: unavailable; ${policy.staleRecords.length} record${policy.staleRecords.length === 1 ? ' was' : 's were'} kept stale by a converging probe and ${policy.staleRecords.length === 1 ? 'is' : 'are'} not current evidence: ${policy.staleRecords.map((k) => `${k.claimId}/${k.faultId}`).join(', ')}. Probe them (or run the full probe) and ask again`
  : policy.state === 'passed'
  ? 'assertion policy: passed; every kill was made by at least one assertion'
  : `assertion policy: failed; ${policy.exceptionOnlyKills.length} kill${policy.exceptionOnlyKills.length === 1 ? ' was' : 's were'} by exception only, not by assertion: ${policy.exceptionOnlyKills.map((k) => `${k.claimId}/${k.faultId}${k.reason ? ` (${k.reason}: the runner reported no error identity, so nothing could be read; the suite may not be hollow)` : ''}`).join(', ')}. Where the runner did report, the suite reached the code but never checked a value; add an assertion on the behavior`;
