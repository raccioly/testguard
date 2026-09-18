/**
 * The verdict function. Pure: everything it needs is passed in, so every
 * branch is unit-testable without a runner.
 *
 * Order matters. Each check short-circuits the ones below it, and the order
 * encodes GATE-SEMANTICS.md: nothing to run → nocover; nothing to apply →
 * unverifiable; defenders not green → flaky-defender; then, and only then,
 * does the fault's own result count.
 *
 * `subjectReached` is the negative control's answer and is consulted at one
 * point only: a would-be `survived`. It is never asked about a kill — a kill
 * already proves the defenders reached the code — and `undefined` (the control
 * was not run) never changes a verdict.
 */
export function classify({ defenders, anchor, baselineRuns, probeRuns, confirmRuns, subjectReached }) {
  if (defenders.length === 0) return { verdict: 'nocover' };
  if (anchor && anchor.status !== 'ok') return { verdict: 'unverifiable', reason: anchor.status };
  if (baselineRuns.length === 0 || baselineRuns.some((r) => r.outcome !== 'pass')) {
    return { verdict: 'flaky-defender', reason: 'defenders-not-green' };
  }
  const loadError = probeRuns.find((r) => r.outcome === 'error');
  if (loadError) {
    // esbuild/vitest wording: "Transform failed with 1 error", `Expected ")" but found ";"`, "Unexpected token"
    const parseError = /syntax|parse|transform failed|expected .+ but found|unexpected token/i.test(loadError.loadMessage ?? '');
    return { verdict: 'fault-invalid', reason: parseError ? 'replacement-does-not-compile' : 'suite-failed-to-load' };
  }
  if (probeRuns.some((r) => r.outcome === 'timeout' || r.timeouts > 0)) return { verdict: 'timeout', reason: 'test-timed-out' };

  const killedRuns = probeRuns.filter((r) => r.outcome === 'fail' && r.assertionFailures > 0);
  const passedRuns = probeRuns.filter((r) => r.outcome === 'pass');
  if (probeRuns.length === confirmRuns && killedRuns.length === confirmRuns) return { verdict: 'killed' };
  if (probeRuns.length === confirmRuns && passedRuns.length === confirmRuns) {
    // The negative control. A green baseline proves the defenders can PASS; it
    // says nothing about whether they can fail because of THIS file. If the
    // subject was replaced with something that cannot compile and the
    // defenders still went green, they never execute it — and then `survived`
    // is a statement about their reach, not their assertions, and reads as a
    // devastating audit finding while being entirely false.
    // `undefined` means the control was not run, which is not evidence either
    // way and leaves the verdict alone.
    if (subjectReached === false) return { verdict: 'unverifiable', reason: 'subject-not-executed' };
    return { verdict: 'survived' };
  }
  // Some runs killed, some passed: the defenders' response to this fault is
  // nondeterministic. Reporting it as killed would be the optimistic bias
  // the research warned about; reporting survived would be a lie the other way.
  return { verdict: 'flaky-defender', reason: 'inconsistent-probe' };
}

/** Decide whether another probe run is worth doing, or the verdict is already forced. */
export function shouldStopEarly(probeRuns) {
  const last = probeRuns[probeRuns.length - 1];
  return last.outcome === 'error' || last.outcome === 'timeout' || last.timeouts > 0;
}
