/**
 * The decisions escalation and flake measurement make, as pure functions.
 *
 * These used to live inline in `probeOne`, which meant the only thing that
 * could falsify them was a full fixture probe — a 50-second acceptance test
 * standing in for a rule you can state in three lines. `classify()` has always
 * been pure for this reason: the order of its checks *is* the spec, and every
 * branch is unit-testable without a runner. Same principle here.
 *
 * Nothing in this file runs a test, touches the filesystem, or knows what a
 * worktree is. Everything it needs is passed in.
 */

const isKill = (r) => r.outcome === 'fail' && (r.assertionFailures ?? 0) > 0;

/**
 * Fold one escalation run into the running attribution state.
 *
 * A test is an undeclared killer only if it fails in **every** run: a single
 * run cannot say, because a test that is flaky elsewhere in the suite would
 * take the credit. So the killer set is an intersection, seeded by the first
 * run rather than by the empty set.
 *
 * Once the intersection is empty no further run can name a killer, so the
 * caller may stop early. Stopping can only fail to *name* a killer, never
 * upgrade a verdict, which is the pessimistic side and therefore the safe one.
 */
export function foldEscalationRun(state, { run, failedTests }) {
  const runs = [...state.runs, run];
  const killers = state.killers === null ? new Set(failedTests) : new Set([...state.killers].filter((t) => failedTests.includes(t)));
  return { runs, killers, stoppedEarly: killers.size === 0 ? 'no-common-failure' : undefined };
}

/** The initial attribution state, before any escalation run. */
export const escalationStart = () => ({ runs: [], killers: null, stoppedEarly: undefined });

/**
 * What escalation concluded. `undeclaredKillers` is named only when a test
 * failed in all N runs AND every run was a genuine kill (an assertion
 * failure). A suite that errored or timed out proves nothing about the fault,
 * so it never earns an attribution.
 */
export function escalationResult(state, confirmRuns) {
  const complete = state.runs.length === confirmRuns;
  const attributable = state.killers !== null && state.killers.size > 0 && complete && state.runs.every(isKill);
  return {
    escalated: true,
    escalationRuns: state.runs,
    ...(state.stoppedEarly ? { escalationStoppedEarly: state.stoppedEarly } : {}),
    ...(attributable ? { reason: 'killed-by-undeclared-tests', undeclaredKillers: [...state.killers].sort() } : {}),
  };
}

/**
 * The defenders' flake rate on unmodified source.
 *
 * Only runs that **actually ran** carry information. A load error or a timeout
 * measures the environment, not the suite's stability, and counting either as
 * a "failure" would invent flakiness that was never observed. Returns
 * `undefined` when nothing was measurable, so the caller omits the field
 * rather than recording a rate of zero it cannot support.
 */
export function flakeRate(runs) {
  const measured = runs.filter((r) => r.outcome === 'pass' || r.outcome === 'fail');
  if (!measured.length) return undefined;
  return { runs: measured.length, failures: measured.filter((r) => r.outcome === 'fail').length };
}

/**
 * The tests that actually failed on the fault, by file. Only these are its
 * killers; everything else in a run is noise for attribution purposes.
 */
export function killersFromRuns(probeRuns) {
  return [...new Set(probeRuns.flatMap((r) => r.failedTests ?? []).map((t) => t.split('::')[0]).filter(Boolean))];
}

/**
 * The `subject` of an evidence record. `contentHash` is what makes a fault edit
 * visible: weakening a fault after it survived changes this hash, and `status`
 * reports the change with the verdict the fault used to have. It is deliberately
 * NOT part of the fingerprint — repairing a rotted anchor must not churn the
 * baseline — which is exactly why it has to be recorded separately.
 */
export function subjectOf(fault, sha256) {
  return {
    kind: 'fault',
    id: fault.id,
    description: fault.description,
    file: fault.file,
    faultClass: fault.faultClass,
    producedBy: fault.producedBy,
    contentHash: sha256(`${fault.find}\n${fault.replace}`),
  };
}
