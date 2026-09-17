import * as vitest from './vitest.mjs';
import * as jest from './jest.mjs';
import * as playwright from './playwright.mjs';

export const RUNNERS = { vitest, jest, playwright };

/**
 * Runners that own files rather than projects: a defender under Playwright's
 * testDir runs under Playwright whatever the project runner is. `auto` never
 * picks one of these for the whole project; `--runner playwright` does.
 */
export const OWNED_RUNNERS = [playwright];

/**
 * Pick the project runner: an explicit name, or the first of vitest, jest that
 * is resolvable from the project. Returns { runner, version } or { error }.
 */
export async function selectRunner({ projectDir, name = 'auto' }) {
  const candidates = name === 'auto' ? [vitest, jest] : [RUNNERS[name]];
  if (!candidates[0]) return { error: `unknown runner "${name}"; use vitest, jest, playwright or auto` };
  const messages = [];
  for (const r of candidates) {
    const c = await r.check({ projectDir });
    if (c.ok) return { runner: r, version: c.version };
    messages.push(`${r.name}: ${c.message}`);
  }
  return { error: messages.join('; ') };
}

/** The runner a test file runs under: an owning runner if one claims it, else the project runner. */
export function runnerFor(projectDir, file, primary) {
  if (primary.owns?.(projectDir, file)) return primary;
  return OWNED_RUNNERS.find((r) => r !== primary && r.owns(projectDir, file)) ?? primary;
}

/** Group files by the runner they run under, in a stable order (primary first). */
export function partitionByRunner(projectDir, files, primary) {
  const groups = new Map([[primary, []]]);
  for (const f of files) {
    const r = runnerFor(projectDir, f, primary);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(f);
  }
  if (groups.get(primary).length === 0 && groups.size > 1) groups.delete(primary);
  return groups;
}

/**
 * Merge the runs of several runners into one testRun, pessimistically: any
 * load error is an error, any timeout is a timeout, any failure is a failure.
 * Counts add; failed test ids concatenate.
 */
export function mergeRuns(parts) {
  if (parts.length === 1) return parts[0];
  const runs = parts.map((p) => p.run);
  const outcome = runs.some((r) => r.outcome === 'error') ? 'error' : runs.some((r) => r.outcome === 'timeout') ? 'timeout' : runs.some((r) => r.outcome === 'fail') ? 'fail' : 'pass';
  const sum = (k) => runs.reduce((n, r) => n + (r.tests[k] ?? 0), 0);
  return {
    run: { outcome, tests: { total: sum('total'), passed: sum('passed'), failed: sum('failed') }, assertionFailures: runs.reduce((n, r) => n + r.assertionFailures, 0), durationMs: runs.reduce((n, r) => n + r.durationMs, 0) },
    timeouts: parts.reduce((n, p) => n + (p.timeouts ?? 0), 0),
    loadMessage: parts.find((p) => p.loadMessage)?.loadMessage,
    failedTests: parts.flatMap((p) => p.failedTests ?? []),
  };
}
