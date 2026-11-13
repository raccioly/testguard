import { readFileSync, realpathSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { git, GitError } from '../git.mjs';
import { SOURCE_EXT, isDefaultExcluded } from '../gate/changed.mjs';
import { resolveDefenders } from './runners/shared.mjs';
import { discoverDefendersDetailed } from './discover.mjs';
import { defenderSelection } from './attribution.mjs';
import { createDependencyHasher } from './dependencies.mjs';
import { globToRegExp } from '../util/glob.mjs';
import { CONFIG_FILE } from '../config/config-file.mjs';

/**
 * `probe --changed <ref>`: which claims a change can have affected.
 *
 * A claim is selected when a fault's target, one of its defenders (as the claim
 * names them or as discovery resolves them) or anything in their import
 * closure differs between `merge-base(ref, HEAD)` and the tree being probed.
 * Selection errs toward probing: a closure that cannot be followed selects the
 * claim, because "could not tell" read as "unaffected" is a narrowed run that
 * says nothing about what it left out.
 *
 * There are three outcomes and they are never confused:
 *   - `determined`, with claims;
 *   - `determined`, with none: the change touches nothing any claim depends on;
 *   - `undetermined`: git could not say what changed. That is not an empty
 *     change, and it never narrows a run.
 */

export const SCOPE_NOTE = 'not covered by any claim; absence from the results is not a pass';

/**
 * Every git invocation on the `--changed` selection path, by site. Adding one
 * means adding its name here, a stub for it in test/probe-scope-git.test.mjs
 * and a decision about what its failure means: a call nobody reviewed is a
 * place where a failure can read as "no change".
 */
export const SCOPE_GIT_SITES = Object.freeze(['repo-root', 'resolve-ref', 'merge-base', 'head', 'diff', 'untracked']);

/** Why the change could not be measured. `kind` is the closed set a caller branches on. */
export class ScopeUndetermined extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const CI_HINT = 'In CI the base must be present locally: GitHub Actions — actions/checkout with fetch-depth: 0; GitLab — GIT_DEPTH: 0 or `git fetch origin <target branch>` before the job.';

function runSite(site, args, cwd, { timeoutMs, failure }) {
  try {
    return git(args, cwd, undefined, timeoutMs === undefined ? undefined : { timeoutMs });
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    const kind = error.timedOut ? 'git-timeout' : failure(site);
    throw new ScopeUndetermined(kind, `${site}: ${error.message.split('\n')[0]}${kind === 'no-merge-base' ? `. ${CI_HINT}` : ''}`);
  }
}

/** `-z` name-status output → one entry per change, with both sides of a rename or copy. */
export function parseNameStatus(out) {
  const parts = out.split('\0');
  const changes = [];
  for (let i = 0; i < parts.length; i += 1) {
    const status = parts[i];
    if (!status) continue;
    if (/^[RC]/.test(status)) {
      changes.push({ status: status[0], paths: [parts[i + 1], parts[i + 2]].filter(Boolean) });
      i += 2;
    } else {
      changes.push({ status: status[0], paths: [parts[i + 1]].filter(Boolean) });
      i += 1;
    }
  }
  return changes;
}

/**
 * Files that differ between `merge-base(ref, HEAD)` and HEAD (or the working
 * tree, with `includeDirty`), project-relative. Deletions are kept: a deleted
 * defender is a change. A rename or copy contributes its old path and its new
 * one, so a claim that still names the old path is selected as surely as one
 * that names the new.
 */
export function changedSince({ projectDir, ref, includeDirty = false, timeoutMs }) {
  const options = { timeoutMs, failure: (site) => (site === 'resolve-ref' ? 'ref-unresolved' : site === 'merge-base' ? 'no-merge-base' : 'git-failed') };
  // An argument that git would read as an option is not a ref.
  if (ref.startsWith('-')) throw new ScopeUndetermined('ref-unresolved', `resolve-ref: ${ref} is not a ref`);
  const root = runSite('repo-root', ['rev-parse', '--show-toplevel'], projectDir, options);
  try {
    runSite('resolve-ref', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root, options);
  } catch (error) {
    if (error instanceof ScopeUndetermined && error.kind === 'ref-unresolved') throw new ScopeUndetermined('ref-unresolved', `resolve-ref: ${ref} does not resolve to a commit in this repository`);
    throw error;
  }
  const base = runSite('merge-base', ['merge-base', ref, 'HEAD'], root, options);
  const head = runSite('head', ['rev-parse', 'HEAD'], root, options);
  const diff = runSite('diff', ['diff', '--name-status', '-M', '-C', '-z', base, ...(includeDirty ? [] : ['HEAD'])], root, options);
  const paths = new Set(parseNameStatus(diff).flatMap((change) => change.paths));
  if (includeDirty) {
    for (const file of runSite('untracked', ['ls-files', '--others', '--exclude-standard', '-z'], root, options).split('\0').filter(Boolean)) paths.add(file);
  }
  const prefix = relative(realpathSync(root), realpathSync(resolve(projectDir))).split('\\').join('/');
  const files = [...paths].flatMap((file) => {
    if (!prefix) return [file];
    return file.startsWith(`${prefix}/`) ? [file.slice(prefix.length + 1)] : [];
  });
  // `repoChanged`: the change outside the project counts too. A project that
  // is one package of a monorepo runs its siblings' code through workspace
  // links; a closure that crosses into them is indeterminate, and a change
  // there must still select it even though no project file moved (#268).
  return { base, head, files: files.sort(), repoChanged: paths.size };
}

/**
 * The discovery inputs each claim's evidence recorded (`inputs.discoveryHashes`),
 * read from the project's evidence when there is one (#297): a candidate test
 * that was deleted is no candidate at HEAD, and only the record remembers it.
 * Best effort and only ever widening: unreadable evidence adds nothing.
 */
function recordedDiscovery(projectDir) {
  const byClaim = new Map();
  let doc;
  try { doc = JSON.parse(readFileSync(join(projectDir, '.testguard', 'evidence.json'), 'utf8')); } catch { return byClaim; }
  for (const record of Array.isArray(doc?.records) ? doc.records : []) {
    const id = record?.claim?.id;
    const files = Object.keys(record?.inputs?.discoveryHashes ?? {});
    if (typeof id !== 'string' || !files.length) continue;
    if (!byClaim.has(id)) byClaim.set(id, new Set());
    for (const file of files) byClaim.get(id).add(file);
  }
  return byClaim;
}

/** Everything one claim's verdicts depend on, as project-relative paths and literals. */
function dependenciesOf(projectDir, claim, hasher, recorded = new Set()) {
  // testguard.config.json (#301) decides how every defender runs, like a
  // lockfile decides what they run against: a change to it reaches every
  // claim. Named whether or not it exists, so a deleted one selects too.
  // Which of those verdicts really moved is reuse's question, not this one.
  const named = new Set([CONFIG_FILE]);
  const globs = [];
  // A discovered defender set depends on every candidate test file and what
  // they import (#297): an edit there can give the claim a defender. Kept
  // apart from `named` so the reason can say which input it was.
  const discovery = new Set(recorded);
  let discoveryIndeterminate = false;
  let indeterminate = false;
  let issue;
  for (const fault of claim.faults) {
    named.add(fault.file);
    const { requested } = defenderSelection(claim, fault);
    for (const entry of requested) {
      named.add(entry);
      globs.push(entry);
    }
    let defenders;
    if (requested.length) defenders = resolveDefenders(projectDir, requested);
    else {
      const detailed = discoverDefendersDetailed(projectDir, fault.file);
      defenders = detailed.canDetect;
      for (const file of detailed.dependencies) discovery.add(file);
      if (detailed.indeterminate.length) discoveryIndeterminate = true;
    }
    for (const defender of defenders) named.add(defender);
    const inputs = hasher.inputsFor([fault.file, ...defenders]);
    for (const file of Object.keys(inputs.dependencyHashes)) named.add(file);
    if (inputs.dependencyClosure !== 'complete') { indeterminate = true; issue ??= inputs.dependencyIssues?.[0]; }
  }
  // Discovery that cannot be followed cannot rule a change out either.
  if (discoveryIndeterminate) indeterminate = true;
  return { named, discovery, globs: globs.map((glob) => ({ glob, re: globToRegExp(glob) })), indeterminate, issue };
}

/**
 * Select the claims a change affects.
 *
 * @returns {{outcome: 'determined', ref, base, head, includeDirty, files, matchedClaims, unmatchedFiles, selected, note}
 *   | {outcome: 'undetermined', ref, reason: {kind, message}}}
 */
export function resolveProbeScope({ projectDir, claims, ref, includeDirty = false, only, timeoutMs }) {
  let changed;
  try {
    changed = changedSince({ projectDir, ref, includeDirty, timeoutMs });
  } catch (error) {
    if (error instanceof ScopeUndetermined) return { outcome: 'undetermined', ref, reason: { kind: error.kind, message: error.message } };
    throw error;
  }
  // The closures describe the tree the probe will measure: the commit, plus
  // the untracked files git does not ignore when the working tree is
  // snapshotted. Never an ignored directory (#272).
  const hasher = createDependencyHasher(projectDir, { untracked: includeDirty });
  const touched = new Set();
  const matched = new Set();
  const reasons = new Map();
  const recorded = recordedDiscovery(projectDir);
  for (const claim of claims.claims) {
    const { named, discovery, globs, indeterminate, issue } = dependenciesOf(projectDir, claim, hasher, recorded.get(claim.id));
    for (const file of named) touched.add(file);
    // Why the claim is selected, so an over-selection can be read off the
    // document (#272): the first changed file it names, else the first one a
    // defender glob matches, else the first reason its closure is indeterminate.
    const byFile = changed.files.find((file) => named.has(file));
    const byGlob = byFile ? undefined : changed.files.map((file) => ({ file, entry: globs.find((g) => g.re.test(file)) })).find((hit) => hit.entry);
    const byDiscovery = byFile || byGlob ? undefined : changed.files.find((file) => discovery.has(file));
    if (byFile) reasons.set(claim.id, { claimId: claim.id, kind: 'file', file: byFile });
    else if (byGlob) reasons.set(claim.id, { claimId: claim.id, kind: 'glob', file: byGlob.file, glob: byGlob.entry.glob });
    else if (byDiscovery) reasons.set(claim.id, { claimId: claim.id, kind: 'discovery', file: byDiscovery });
    // A closure that cannot be followed cannot rule the change out, but with no change there is nothing to rule out.
    // "No change" is measured over the whole repository: what the closure could not follow may lie outside the project.
    else if (indeterminate && (changed.repoChanged ?? changed.files.length) > 0) reasons.set(claim.id, { claimId: claim.id, kind: 'indeterminate', ...(issue ? { issue } : {}) });
    if (reasons.has(claim.id)) matched.add(claim.id);
  }
  const selected = (only ?? claims.claims.map((claim) => claim.id)).filter((id) => matched.has(id));
  const unmatchedFiles = changed.files.filter((file) => SOURCE_EXT.has(extname(file)) && !isDefaultExcluded(file) && !touched.has(file));
  return {
    outcome: 'determined',
    ref,
    base: changed.base,
    head: changed.head,
    includeDirty,
    files: changed.files,
    matchedClaims: claims.claims.map((claim) => claim.id).filter((id) => matched.has(id)),
    matchReasons: claims.claims.filter((claim) => matched.has(claim.id)).map((claim) => reasons.get(claim.id)),
    unmatchedFiles,
    selected,
    note: SCOPE_NOTE,
  };
}
