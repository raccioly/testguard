// Semantic rules for the invocation result (`run`) of a `probe --json` status
// document: the per-claim results and the selection scope. The schema says
// what may appear; these say which combinations are honest.

const COUNTERS = { killed: 'killed', survived: 'survived', nocover: 'nocover', unverifiable: 'unverifiable', 'fault-invalid': 'faultInvalid', timeout: 'timeout', 'flaky-defender': 'flakyDefender' };

/** The result a set of fault counts must carry (GATE-SEMANTICS.md, "Per-claim results"). */
export function resultOf(faults) {
  if (faults.survived > 0 || faults.nocover > 0) return 'unproven';
  if (faults.total >= 1 && faults.killed === faults.total) return 'proven';
  return 'could-not-verify';
}

function claimErrors(claims) {
  const errors = [];
  claims.forEach((claim, i) => {
    const p = `/run/claims/${i}`;
    const f = claim.faults;
    const sum = Object.values(COUNTERS).reduce((n, key) => n + f[key], 0);
    if (f.total !== sum) errors.push({ path: `${p}/faults/total`, message: `total (${f.total}) must equal the sum of the verdict counts (${sum})` });
    if (claim.result !== resultOf(f)) errors.push({ path: `${p}/result`, message: `${claim.id} reports ${claim.result} but its counts make it ${resultOf(f)}: proven needs every measured fault killed, any survived or nocover is unproven, anything else is could-not-verify` });
    const ids = new Set();
    const tally = Object.fromEntries(Object.keys(COUNTERS).map((v) => [v, 0]));
    for (const reason of claim.reasons) {
      if (reason.verdict === 'killed') errors.push({ path: `${p}/reasons`, message: 'a killed fault has no reason to list' });
      if (ids.has(reason.faultId)) errors.push({ path: `${p}/reasons`, message: `fault ${reason.faultId} is listed twice` });
      ids.add(reason.faultId);
      tally[reason.verdict] += 1;
    }
    for (const [verdict, key] of Object.entries(COUNTERS)) {
      if (verdict !== 'killed' && tally[verdict] !== f[key]) errors.push({ path: `${p}/reasons`, message: `${f[key]} ${verdict} fault(s) counted but ${tally[verdict]} listed: every fault that was not killed carries one reason` });
    }
  });
  const seen = new Set();
  claims.forEach((claim, i) => {
    if (seen.has(claim.id)) errors.push({ path: `/run/claims/${i}/id`, message: `claim ${claim.id} appears twice` });
    seen.add(claim.id);
  });
  return errors;
}

export function runErrors(run) {
  const errors = [];
  const measured = run.id !== undefined;
  const scope = run.scope;
  if (run.claims && scope && !sameSet(run.claims.map((c) => c.id), scope.probedClaims)) errors.push({ path: '/run/claims', message: 'run.claims must name exactly the probed claims' });
  if (run.claims) errors.push(...claimErrors(run.claims));
  if (!scope) return errors;

  if (scope.requestedClaims && scope.requestedCount !== scope.requestedClaims.length) errors.push({ path: '/run/scope/requestedCount', message: 'requestedCount must equal requestedClaims.length' });
  if (scope.probedCount !== scope.probedClaims.length) errors.push({ path: '/run/scope/probedCount', message: 'probedCount must equal probedClaims.length' });
  if (scope.state !== undefined && !measured) errors.push({ path: '/run/scope/state', message: 'only a measured run has a state of its own: an invocation that probed nothing has no selection to describe' });
  const target = scope.next?.target;
  if (target && !scope.probedClaims.includes(target.claimId)) errors.push({ path: '/run/scope/next/target/claimId', message: `the selection's next action names ${target.claimId}, which this invocation did not probe: a claim outside the selection belongs to the whole file's next, not the selection's` });
  if (scope.state === 'unclaimed-changes' || scope.state === 'no-claims') errors.push({ path: '/run/scope/state', message: `${scope.state} describes the whole file or change; a selection of claims cannot be in it` });
  const requested = scope.requestedClaims ? new Set(scope.requestedClaims) : null;
  if (requested && scope.probedClaims.some((id) => !requested.has(id))) errors.push({ path: '/run/scope/probedClaims', message: 'every probed claim must have been requested' });

  const changed = scope.changed;
  if (!changed) {
    if (scope.selectedCount !== undefined) errors.push({ path: '/run/scope/selectedCount', message: 'selectedCount belongs to a --changed selection' });
    if (!requested) errors.push({ path: '/run/scope', message: 'a scope names a --claim request or a --changed selection; this one names neither' });
    if (!measured) errors.push({ path: '/run', message: 'an invocation that measured nothing must say why through scope.changed' });
    return errors;
  }

  if (changed.outcome === 'undetermined') {
    if (measured) errors.push({ path: '/run/id', message: 'an undetermined change selects nothing: no measurement may follow it' });
    if (run.exitCode !== 2) errors.push({ path: '/run/exitCode', message: 'an undetermined change exits 2; it is never an empty change' });
    if (scope.probedCount !== 0) errors.push({ path: '/run/scope/probedCount', message: 'an undetermined change probed nothing' });
    if (scope.selectedCount !== undefined) errors.push({ path: '/run/scope/selectedCount', message: 'an undetermined change selected nothing, not zero claims: it has no selectedCount' });
    return errors;
  }

  const matched = new Set(changed.matchedClaims);
  const files = new Set(changed.files);
  if (changed.unmatchedFiles.some((file) => !files.has(file))) errors.push({ path: '/run/scope/changed/unmatchedFiles', message: 'an unmatched file must be one of the changed files' });
  if (scope.probedClaims.some((id) => !matched.has(id))) errors.push({ path: '/run/scope/probedClaims', message: 'every probed claim must have been matched by the change' });
  if (scope.selectedCount === undefined) errors.push({ path: '/run/scope/selectedCount', message: 'a determined --changed selection reports selectedCount' });
  else {
    const expected = requested ? [...requested].filter((id) => matched.has(id)).length : matched.size;
    if (scope.selectedCount !== expected) errors.push({ path: '/run/scope/selectedCount', message: `selectedCount (${scope.selectedCount}) must be the matched claims left after --claim (${expected})` });
    if (measured && scope.selectedCount !== scope.probedCount) errors.push({ path: '/run/scope/probedCount', message: 'every selected claim is probed' });
    if (!measured) {
      if (scope.selectedCount !== 0) errors.push({ path: '/run/id', message: 'a run with claims selected measures them: it has an id and evidence' });
      if (run.exitCode === 1) errors.push({ path: '/run/exitCode', message: 'an empty selection exits 0, or 2 under --fail-on-empty-selection; it cannot find anything unproven' });
    }
  }
  return errors;
}

const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));
