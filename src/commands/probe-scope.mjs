import { resolveProbeScope } from '../probe/scope.mjs';
import { selectClaims } from '../probe/probe.mjs';

/**
 * The `--changed` half of `probe`: turn a reference into the claims to probe,
 * and say what the answer was. Kept out of probe.mjs so the probe loop and this
 * selection never need to change together.
 *
 * Returns `{ outcome, ... }`:
 *   - `selected`   → probe `only`; `scope` is the part of run.scope known so far;
 *   - `empty`      → nothing selected; no probe runs; exit 0 (2 under --fail-on-empty-selection);
 *   - `undetermined` → git could not say what changed; exit 2, nothing runs.
 */
export function selectByChange({ projectDir, claims, ref, includeDirty, only, failOnEmpty, timeoutMs }) {
  // Unknown ids are the caller's mistake whatever the change is; say so before measuring anything.
  if (only) selectClaims(claims.claims, only);
  const scope = resolveProbeScope({ projectDir, claims, ref, includeDirty, only, timeoutMs });
  if (scope.outcome === 'undetermined') {
    return { outcome: 'undetermined', exitCode: 2, scope: { probedClaims: [], probedCount: 0, changed: { ref, outcome: 'undetermined', reason: scope.reason } } };
  }
  const changed = { ref, outcome: 'determined', base: scope.base, head: scope.head, includeDirty, files: scope.files, matchedClaims: scope.matchedClaims, unmatchedFiles: scope.unmatchedFiles, note: scope.note };
  if (scope.selected.length === 0) {
    return { outcome: 'empty', exitCode: failOnEmpty ? 2 : 0, scope: { ...(only ? { requestedClaims: only, requestedCount: only.length } : {}), probedClaims: [], probedCount: 0, selectedCount: 0, changed } };
  }
  return { outcome: 'selected', only: scope.selected, changed };
}

/** The finished `run.scope` for a measured invocation. */
export function measuredScope({ requested, changed, records }) {
  if (!requested && !changed) return undefined;
  const probedClaims = [...new Set(records.map((record) => record.claim.id))];
  return {
    ...(requested ? { requestedClaims: requested, requestedCount: requested.length } : {}),
    probedClaims,
    probedCount: probedClaims.length,
    ...(changed ? { selectedCount: probedClaims.length, changed } : {}),
  };
}

/** Human lines for an invocation that selected nothing or could not tell. */
export function renderNoSelection(selection, { failOnEmpty }) {
  const { changed } = selection.scope;
  if (selection.outcome === 'undetermined') {
    return [`error: cannot tell what changed since ${changed.ref} (${changed.reason.kind}): ${changed.reason.message}. Nothing was probed: a run narrowed to an unknown change would prove nothing.`];
  }
  const lines = [`--changed ${changed.ref}: no claim depends on anything that changed (${changed.files.length} file${changed.files.length === 1 ? '' : 's'} differ since merge-base ${changed.base.slice(0, 7)}); 0 claims selected, nothing probed. This is not a pass for the change: it says no claim was in its way.`];
  lines.push(...renderUnmatched(changed));
  if (failOnEmpty) lines.push('exit 2: --fail-on-empty-selection treats an empty selection as a failure to prove anything.');
  return lines;
}

/** The changed source files no claim covers; absence from the results says nothing about them. */
export const renderUnmatched = (changed) => changed.unmatchedFiles.length === 0 ? [] : [`${changed.unmatchedFiles.length} changed source file${changed.unmatchedFiles.length === 1 ? ' is' : 's are'} ${changed.note}: ${changed.unmatchedFiles.slice(0, 10).join(', ')}${changed.unmatchedFiles.length > 10 ? ', …' : ''}`];
