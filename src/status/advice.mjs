import { autoFaultWorkers } from '../probe/fan-out.mjs';
import { claimCosts, median, runsOf } from '../probe/cost.mjs';
import { scanInstalled, renderFinding } from '../init/managed.mjs';

/**
 * Where the user is leaving speed on the table (issue #270). One line each,
 * with the exact command to run. Informational: advice never changes `state`,
 * `next`, a verdict or an exit code, and computing it touches no network.
 *
 * Every rule reads only what is already on disk: the last evidence, the
 * machine's CPU count, the change since a base the caller resolved, and the
 * hook and CI files in the repository.
 */
export const ADVICE_IDS = ['serial-on-multicore', 'full-probe-where-changed-would-do', 'nothing-reused', 'slow-defenders-dominate', 'hook-outdated', 'orphaned-scratch'];

/** The last run measured one fault at a time because somebody asked, on a machine where auto would not. */
export function serialAdvice(run, cpus) {
  if (!run || run.faultWorkers > 1) return undefined;
  const source = run.faultWorkersSource;
  // Evidence from before the field existed was serial whatever was asked; an
  // automatic one was the machine's own answer, and another machine's.
  if (source === 'auto' || source === 'in-place') return undefined;
  const auto = autoFaultWorkers(cpus);
  if (auto <= 1) return undefined;
  const why = source === 'serial' ? 'with --serial' : source === 'flag' ? 'with --fault-workers 1' : source === 'env' ? 'with TESTGUARD_FAULT_WORKERS=1' : 'one fault at a time (TestGuard before 0.24)';
  return { id: 'serial-on-multicore', message: `The last probe ran ${why} on a machine with ${cpus} CPUs; without it, ${auto} faults run at once and every kill is still confirmed alone.`, command: 'testguard probe' };
}

/** A full probe where the change since a base would have selected fewer claims. */
export function changedAdvice({ selected, total, ref }) {
  if (!ref || !(total > 0) || !(selected < total)) return undefined;
  return { id: 'full-probe-where-changed-would-do', message: `Your change since ${ref} can affect ${selected} of ${total} claims; probe just those in the inner loop and keep the full probe for the nightly job.`, command: 'testguard probe --changed auto' };
}

/** The last probe carried nothing forward, so it paid for every fault. */
export function reuseAdvice(run, records) {
  if (!run?.reuse || run.reuse.reused > 0 || !(records > 0)) return undefined;
  const seconds = Math.round((run.measurements?.elapsedMs ?? 0) / 1000);
  if (seconds < 60) return undefined;
  return { id: 'nothing-reused', message: `The last probe reused no verdict and measured all ${records} faults (${seconds}s). Keep .testguard/evidence.json between runs (in CI, cache it) and the next probe re-measures only what changed.`, command: 'testguard probe' };
}

/**
 * Cost concentrated in a few slow defenders (#291). Read from the durations the
 * last probe recorded; nothing is run. The thresholds come from measured
 * evidence, both ways: this repository's own (141 claims, 1,651s) has its
 * costliest claim at 6.2% of the time and its slowest claim at a median 9.9s
 * per run, so a claim must hold at least 10% and run at least 15s to be named
 * (silent here, no false alarm); the field run that prompted the rule had
 * claims at 34% (73s per run) and 18% (32s), the next at 7%. Too little data
 * says nothing: under 20 claims, under 600s of defender time, under 5 runs.
 */
export const COST_RULE = Object.freeze({ minClaims: 20, minTotalSeconds: 600, minShare: 0.10, minMedianSeconds: 15, minRuns: 5, minCombinedShare: 0.25, maxNamed: 3 });

export function costAdvice(evidence) {
  if (!Array.isArray(evidence?.records)) return undefined;
  const records = evidence.records.filter((r) => typeof r?.claim?.id === 'string');
  const claims = claimCosts(records);
  const total = claims.reduce((a, c) => a + c.ms, 0);
  if (claims.length < COST_RULE.minClaims || total < COST_RULE.minTotalSeconds * 1000) return undefined;
  const durations = (rs) => rs.map((r) => r.durationMs).filter((d) => Number.isFinite(d) && d >= 0);
  const perFile = new Map(); // defender file -> every run that included it
  const perClaim = new Map();
  for (const r of records) {
    const runs = durations(runsOf(r));
    perClaim.set(r.claim.id, [...(perClaim.get(r.claim.id) ?? []), ...runs]);
    for (const file of r.defenders?.resolved ?? []) perFile.set(file, [...(perFile.get(file) ?? []), ...runs]);
  }
  const offenders = claims
    .map((c) => ({ ...c, runsMs: perClaim.get(c.claimId) ?? [] }))
    .filter((c) => c.ms / total >= COST_RULE.minShare && c.runsMs.length >= COST_RULE.minRuns && median(c.runsMs) >= COST_RULE.minMedianSeconds * 1000)
    .slice(0, COST_RULE.maxNamed);
  if (!offenders.length || offenders.reduce((a, c) => a + c.ms, 0) / total < COST_RULE.minCombinedShare) return undefined;
  const line = (c) => {
    // Runs execute a claim's defenders together, so a file's time is the time of every run that included it: the slowest such file is the one to speed up.
    const file = c.defenders.map((f) => ({ f, m: median(perFile.get(f) ?? []), n: (perFile.get(f) ?? []).length })).sort((a, b) => b.m - a.m || a.f.localeCompare(b.f))[0];
    return `${c.claimId} costs ${Math.round(c.ms / 1000)}s: ${file.f} takes a median ${Math.round(file.m / 1000)}s per run and runs ${file.n} times`;
  };
  for (let n = offenders.length; n >= 1; n--) {
    const shown = offenders.slice(0, n);
    const share = Math.round((100 * shown.reduce((a, c) => a + c.ms, 0)) / total);
    const message = `${n} of ${claims.length} claims account for ${share}% of defender time: ${shown.map(line).join('; ')}. Give the claim a faster defender or split the file.`;
    if (message.length <= 512) return { id: 'slow-defenders-dominate', message, command: 'testguard claims --cost' };
  }
  return undefined;
}

/** Installed hooks and CI files that run TestGuard the slow or stale way. */
export function hookAdvice({ root, toolVersion }) {
  let findings;
  try { findings = scanInstalled({ root, toolVersion }); } catch { return []; }
  return findings.slice(0, 5).map((f) => ({
    id: 'hook-outdated',
    message: renderFinding(f).slice(0, 512),
    command: f.reason === 'hook-inactive' ? 'testguard init --activate-hook' : 'testguard init --upgrade',
  }));
}

/** Every advice line that applies, in a fixed order. */
export function computeAdvice({ evidence, cpus, changed, root, toolVersion, orphans = 0 }) {
  const run = evidence?.run;
  return [
    serialAdvice(run, cpus),
    changed ? changedAdvice(changed) : undefined,
    reuseAdvice(run, evidence?.records?.length),
    costAdvice(evidence),
    ...hookAdvice({ root, toolVersion }),
    orphanAdvice(orphans),
  ].filter(Boolean);
}

/** Scratch trees and locks interrupted runs left behind (#311): one line, with the command that removes them. */
export function orphanAdvice(count) {
  if (!(count > 0)) return undefined;
  return { id: 'orphaned-scratch', message: `${count} scratch ${count === 1 ? 'entry' : 'entries'} left by interrupted runs ${count === 1 ? 'is' : 'are'} taking disk space; the next probe removes some, and clean removes all of them (add --dry-run to list first).`, command: 'testguard clean' };
}

/** Human lines for a terminal. */
export const renderAdvice = (advice) => advice.map((a) => `speed     ${a.message} → ${a.command}`);
