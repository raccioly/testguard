import { autoFaultWorkers } from '../probe/fan-out.mjs';
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
export const ADVICE_IDS = ['serial-on-multicore', 'full-probe-where-changed-would-do', 'nothing-reused', 'hook-outdated'];

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

/** Installed hooks and CI files that run TestGuard the slow or stale way. */
export function hookAdvice({ root, toolVersion }) {
  let findings;
  try { findings = scanInstalled({ root, toolVersion }); } catch { return []; }
  return findings.slice(0, 5).map((f) => ({
    id: 'hook-outdated',
    message: renderFinding(f).slice(0, 512),
    command: 'testguard init --upgrade',
  }));
}

/** Every advice line that applies, in a fixed order. */
export function computeAdvice({ evidence, cpus, changed, root, toolVersion }) {
  const run = evidence?.run;
  return [
    serialAdvice(run, cpus),
    changed ? changedAdvice(changed) : undefined,
    reuseAdvice(run, evidence?.records?.length),
    ...hookAdvice({ root, toolVersion }),
  ].filter(Boolean);
}

/** Human lines for a terminal. */
export const renderAdvice = (advice) => advice.map((a) => `speed     ${a.message} → ${a.command}`);
