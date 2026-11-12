#!/usr/bin/env node
/**
 * How much of its own claims should this CI run probe?
 *
 * `full`   every fault of every claim. Pushes to main, the nightly schedule,
 *          manual dispatches, release branches, and any pull request whose
 *          change can alter every verdict.
 * `scoped` `probe . --changed origin/<base>`: only the claims a pull request can
 *          have affected.
 *
 * A scoped run does NOT prove the claims it left out. Those are proved by the
 * full run on `main` after the merge, the nightly run, and the release run.
 *
 * Prints the decision and why; writes `mode=` to $GITHUB_OUTPUT.
 *   usage: self-probe-scope.mjs --event <name> [--head-ref <ref>] [--ref-name <ref>] [--base <ref>] [--files-from <file>]
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** A path, or a directory prefix ending in `/`, whose change can alter every verdict or how verdicts are produced. */
export const FULL_PROBE_PATHS = Object.freeze([
  'src/probe/', 'spec/', 'cli/', 'fixtures/',
  'testguard.cost-budget.json',
  'package.json', 'package-lock.json', 'vitest.config.mjs',
  '.github/workflows/ci.yml', '.github/scripts/self-probe-scope.mjs',
  '.github/scripts/measure-reference.mjs', '.github/scripts/check-cost-budget.mjs',
]);

const RELEASE_BRANCH = /^release\//;
export const CLAIMS_FILE = 'testguard.claims.json';

/**
 * The claims whose entry differs between two versions of the claims file,
 * compared as parsed JSON, never as text: added, or changed in any field
 * (statement, source, severity, defendedBy, faults, ...). A removed claim
 * selects nothing: there is nothing left to probe.
 */
export function changedClaimIds(baseDoc, headDoc) {
  const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
  const base = new Map((baseDoc.claims ?? []).map((c) => [c.id, stable(c)]));
  return (headDoc.claims ?? []).filter((c) => base.get(c.id) !== stable(c)).map((c) => c.id);
}

export function decideScope({ event, headRef, refName, changedFiles, claimIds }) {
  if (event !== 'pull_request') return { mode: 'full', reasons: [`event is ${event}, not a pull request`] };
  const branch = headRef ?? refName ?? '';
  if (RELEASE_BRANCH.test(branch)) return { mode: 'full', reasons: [`${branch} is a release branch: its full probe is the one the release verifies`] };
  if (!Array.isArray(changedFiles)) return { mode: 'full', reasons: ['the changed files could not be determined, so nothing is narrowed'] };
  const hits = changedFiles.filter((f) => FULL_PROBE_PATHS.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
  if (hits.length) return { mode: 'full', reasons: [`${hits.length} changed file(s) can alter every verdict: ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ', ...' : ''}`] };
  if (changedFiles.includes(CLAIMS_FILE)) {
    if (!Array.isArray(claimIds)) return { mode: 'full', reasons: [`${CLAIMS_FILE} changed and the claims it changed could not be determined, so nothing is narrowed`] };
    return { mode: 'scoped', claimIds, reasons: [`${changedFiles.length} changed file(s); ${CLAIMS_FILE} changed ${claimIds.length} claim(s)${claimIds.length ? `: ${claimIds.join(', ')}` : ''}, probed in addition to what the change reaches`] };
  }
  return { mode: 'scoped', claimIds: [], reasons: [`${changedFiles.length} changed file(s), none under ${FULL_PROBE_PATHS.join(', ')}`] };
}

export function main(argv, env = process.env) {
  const { values } = parseArgs({ args: argv, options: { event: { type: 'string' }, 'head-ref': { type: 'string' }, 'ref-name': { type: 'string' }, base: { type: 'string' }, 'files-from': { type: 'string' }, 'base-claims-file': { type: 'string' } } });
  if (!values.event) { console.error('usage: self-probe-scope.mjs --event <name> [--head-ref <ref>] [--base <ref>]'); return 2; }
  let changedFiles;
  if (values.event === 'pull_request') {
    try {
      const text = values['files-from'] ? readFileSync(values['files-from'], 'utf8') : execFileSync('git', ['diff', '--name-only', `${values.base}...HEAD`], { encoding: 'utf8' });
      changedFiles = text.split('\n').filter(Boolean);
    } catch { changedFiles = undefined; }
  }
  let claimIds;
  if (changedFiles?.includes(CLAIMS_FILE)) {
    try {
      const base = values['base-claims-file'] ? readFileSync(values['base-claims-file'], 'utf8') : execFileSync('git', ['show', `${values.base}:${CLAIMS_FILE}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      claimIds = changedClaimIds(JSON.parse(base), JSON.parse(readFileSync(CLAIMS_FILE, 'utf8')));
    } catch { claimIds = undefined; }
  }
  const decision = decideScope({ event: values.event, headRef: values['head-ref'], refName: values['ref-name'], changedFiles, claimIds });
  const line = `self-probe scope: ${decision.mode} — ${decision.reasons.join('; ')}`;
  console.log(line);
  if (decision.mode === 'scoped') console.log('A scoped run proves only the claims this change can reach; the rest are proved by the full probe on main after the merge, the nightly run and the release.');
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `mode=${decision.mode}\nclaim_ids=${(decision.claimIds ?? []).join(',')}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### Self-probe scope: ${decision.mode}\n\n${decision.reasons.join('\n')}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
