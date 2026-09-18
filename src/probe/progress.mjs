/**
 * Progress, for readers that are not a terminal (issue #68).
 *
 * The stage line used to be written only when `process.stderr.isTTY`, with a
 * carriage return and an erase-line so it rewrote itself in place. That is the
 * right shape for a human at a terminal and the wrong shape everywhere else,
 * and "everywhere else" is where a probe actually runs: CI, a redirected log,
 * an agent harness. In all of those the tool printed **nothing** for twenty
 * minutes, which is indistinguishable from being hung — and a gate you cannot
 * tell from a hang is a gate people start killing.
 *
 * So the rewriting is a *rendering* choice, not a reason to withhold the
 * information:
 *
 *   tty     `\r`-rewritten single line — unchanged, for a human at a terminal
 *   plain   one line per stage, append-only — a redirected log, CI, an agent
 *   ndjson  one JSON object per line — for a machine that parses progress
 *   none    silence, for `--quiet` and `--json`
 *
 * `auto` picks `tty` when stderr is a terminal and `plain` when it is not.
 * Progress always goes to **stderr**, so `--json` on stdout stays parseable.
 */

/** Which rendering to use. `explicit` is `--progress`; it always wins. */
export function progressMode({ explicit, isTTY = false, quiet = false, json = false } = {}) {
  if (explicit && explicit !== 'auto') return explicit;
  // A silent mode is a choice about output, and an explicit --progress
  // overrides it above; without one, --quiet and --json mean silence.
  if (quiet || json) return 'none';
  return isTTY ? 'tty' : 'plain';
}

/**
 * The stream progress is written to. **Always stderr, never stdout.**
 *
 * stdout carries the result: with `--json` it is one document and nothing
 * else, and every consumer pipes it somewhere that parses it. A progress line
 * on stdout does not degrade that output, it destroys it. The choice is a
 * function so it can be falsified without running a probe.
 */
export const progressStream = (streams) => streams.stderr;

export const PROGRESS_MODES = ['auto', 'tty', 'plain', 'ndjson', 'none'];
export const isProgressMode = (m) => PROGRESS_MODES.includes(m);

/**
 * A stage reporter for the chosen mode, or `undefined` for `none` — the probe
 * takes `undefined` to mean "do not report", so no mode needs a no-op branch
 * inside the hot loop.
 *
 * `plain` prints every stage line, including each run of an N-run phase. That
 * is the point: the thing a reader of a twenty-minute log wants to know is
 * that run 2 of 3 started, which is exactly what the TTY line was already
 * saying and throwing away.
 */
export function stageReporter(mode, write) {
  if (mode === 'none') return undefined;
  if (mode === 'ndjson') {
    return ({ claimId, faultId, stage, i, n }) => write(JSON.stringify({ event: 'stage', claim: claimId, fault: faultId, stage, run: i, of: n, at: new Date().toISOString() }) + '\n');
  }
  if (mode === 'plain') {
    return ({ claimId, faultId, stage, i, n }) => write(`  … ${claimId}/${faultId} ${stage} ${i}/${n}\n`);
  }
  return ({ claimId, faultId, stage, i, n }) => write(`\r\x1b[K  … ${claimId}/${faultId} ${stage} ${i}/${n}`);
}

/**
 * What to write before a verdict line, so a rewritten TTY stage line does not
 * end up with a verdict appended to its tail. Only `tty` needs it; every other
 * mode is append-only and already on its own line.
 */
export const clearStageLine = (mode) => (mode === 'tty' ? '\r\x1b[K' : '');

/**
 * A per-record line for `ndjson`, so a machine watching the stream sees
 * verdicts as they land rather than only at the end.
 */
export const recordEvent = (r) => JSON.stringify({
  event: 'verdict',
  claim: r.claim.id,
  fault: r.subject.id,
  verdict: r.verdict,
  severity: r.claim.severity,
  file: r.subject.file,
  ...(r.reusedFrom ? { reused: true } : {}),
  at: new Date().toISOString(),
}) + '\n';
