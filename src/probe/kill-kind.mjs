/**
 * What kind of failure killed a fault. Pure.
 *
 * A failed test is exactly one of: a timeout, an assertion failure, or an
 * exception. Timeouts never kill. Both of the others do, so the default
 * verdict is unchanged (GATE-SEMANTICS rule 3); the kind is recorded so a
 * policy can ask for more than "the suite went red".
 */

/** Failed tests that count toward a kill: assertion plus exception. Legacy runs carry no `exceptionFailures`. */
export const killingFailures = (run) => (run.assertionFailures ?? 0) + (run.exceptionFailures ?? 0);

/** One run that killed: it failed, and at least one failing test was neither a timeout nor a load failure. */
export const isKillRun = (run) => run.outcome === 'fail' && killingFailures(run) > 0;

/**
 * The kind of a kill, from the N probe runs that produced it.
 *
 *   assertion       every run had at least one assertion-classified failing test
 *   exception-only  no run had one: the suite went red only because the code threw
 *   mixed           some runs had one and some did not (the response was not consistent)
 *
 * `undefined` when there is nothing to classify (no kill runs).
 */
export function killKindOf(probeRuns) {
  const kills = (probeRuns ?? []).filter(isKillRun);
  if (kills.length === 0) return undefined;
  const withAssertion = kills.filter((run) => (run.assertionFailures ?? 0) > 0).length;
  if (withAssertion === kills.length) return 'assertion';
  return withAssertion === 0 ? 'exception-only' : 'mixed';
}
