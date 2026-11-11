import { realpathSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { git, GitError } from '../git.mjs';
import { SOURCE_EXT, isDefaultExcluded } from '../gate/changed.mjs';
import { resolveDefenders } from './runners/shared.mjs';
import { discoverDefenders } from './discover.mjs';
import { defenderSelection } from './attribution.mjs';
import { createDependencyHasher } from './dependencies.mjs';
import { globToRegExp } from '../util/glob.mjs';

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
  return { base, head, files: files.sort() };
}

/** Everything one claim's verdicts depend on, as project-relative paths and literals. */
function dependenciesOf(projectDir, claim, hasher) {
  const named = new Set();
  const globs = [];
  let indeterminate = false;
  for (const fault of claim.faults) {
    named.add(fault.file);
    const { requested } = defenderSelection(claim, fault);
    for (const entry of requested) {
      named.add(entry);
      globs.push(entry);
    }
    const defenders = requested.length ? resolveDefenders(projectDir, requested) : discoverDefenders(projectDir, fault.file);
    for (const defender of defenders) named.add(defender);
    const inputs = hasher.inputsFor([fault.file, ...defenders]);
    for (const file of Object.keys(inputs.dependencyHashes)) named.add(file);
    if (inputs.dependencyClosure !== 'complete') indeterminate = true;
  }
  return { named, globs: globs.map((glob) => ({ glob, re: globToRegExp(glob) })), indeterminate };
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
  const hasher = createDependencyHasher(projectDir);
  const touched = new Set();
  const matched = new Set();
  for (const claim of claims.claims) {
    const { named, globs, indeterminate } = dependenciesOf(projectDir, claim, hasher);
    for (const file of named) touched.add(file);
    const hit = changed.files.some((file) => named.has(file) || globs.some((entry) => entry.re.test(file)));
    // A closure that cannot be followed cannot rule the change out, but with no change there is nothing to rule out.
    if (hit || (indeterminate && changed.files.length > 0)) matched.add(claim.id);
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
    unmatchedFiles,
    selected,
    note: SCOPE_NOTE,
  };
}
