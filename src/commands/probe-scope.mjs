import { resolveProbeScope } from '../probe/scope.mjs';
import { selectClaims } from '../probe/probe.mjs';
import { computeStatus } from '../status/status.mjs';

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
  const changed = { ref, outcome: 'determined', base: scope.base, head: scope.head, includeDirty, files: scope.files, matchedClaims: scope.matchedClaims, matchReasons: scope.matchReasons, unmatchedFiles: scope.unmatchedFiles, note: scope.note };
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

/**
 * `probe --changed <ref> --explain`: the selection, measured and not probed.
 * The `run.scope` a probe would carry, with nothing probed and `explain`
 * set, and its exit: 0 for a determined change whatever it selected (an
 * explanation judges nothing), 2 when git could not say what changed (never
 * 0: "could not tell" is not an answer).
 */
export function explainScope(selection, { requested } = {}) {
  if (selection.outcome !== 'selected') return { exitCode: selection.outcome === 'undetermined' ? 2 : 0, scope: { ...selection.scope, explain: true } };
  return {
    exitCode: 0,
    scope: { ...(requested ? { requestedClaims: requested, requestedCount: requested.length } : {}), probedClaims: [], probedCount: 0, selectedCount: selection.only.length, explain: true, changed: selection.changed },
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One reason, as the line names it: the input that changed, and how the claim reaches it. */
export function renderReason(reason) {
  if (reason.kind === 'file') return `file ${reason.file}${reason.file === 'testguard.config.json' ? ' (the project configuration: every claim depends on it)' : ''}`;
  if (reason.kind === 'glob') return `glob ${reason.file} (matches defendedBy ${reason.glob})`;
  if (reason.kind === 'discovery') return `discovery ${reason.file} (a candidate test, or something one imports, for a claim whose defenders are discovered)`;
  const issue = reason.issue;
  return `indeterminate${issue ? ` ${issue.code} in ${issue.file}${issue.specifier ? ` (${issue.specifier})` : ''}` : ''} (the closure cannot be followed, and something in the repository changed)`;
}

/** The human lines of `--explain`: one per selected claim and why, a count per reason kind, what no claim covers. */
export function renderExplain({ scope, exitCode }, { total }) {
  const changed = scope.changed;
  if (changed.outcome === 'undetermined') return renderNoSelection({ outcome: 'undetermined', scope }, { failOnEmpty: false });
  const selected = scope.requestedClaims ? new Set(scope.requestedClaims) : null;
  const reasons = (changed.matchReasons ?? []).filter((reason) => !selected || selected.has(reason.claimId));
  const lines = [`--changed ${changed.ref}: ${scope.selectedCount} of ${plural(total, 'claim')} selected; ${plural(changed.files.length, 'file')} ${changed.files.length === 1 ? 'differs' : 'differ'} since merge-base ${changed.base.slice(0, 7)}${changed.includeDirty ? ' (working tree included)' : ''}. Nothing was probed (--explain).`];
  const width = Math.max(0, ...reasons.map((reason) => reason.claimId.length));
  for (const reason of reasons) lines.push(`  ${reason.claimId.padEnd(width)}  ${renderReason(reason)}`);
  const counts = Object.fromEntries(['file', 'glob', 'discovery', 'indeterminate'].map((kind) => [kind, reasons.filter((reason) => reason.kind === kind).length]));
  lines.push(`by reason: ${Object.entries(counts).map(([kind, n]) => `${kind} ${n}`).join(', ')}`);
  if (selected && changed.matchedClaims.length > reasons.length) lines.push(`${changed.matchedClaims.length - reasons.length} more matched by the change but not named by --claim.`);
  lines.push(...renderUnmatched(changed));
  if (exitCode === 0 && scope.selectedCount === 0) lines.push('No claim depends on anything that changed. That is not a pass for the change: it says no claim was in its way.');
  return lines;
}

/** The changed source files no claim covers; absence from the results says nothing about them. */
export const renderUnmatched = (changed) => changed.unmatchedFiles.length === 0 ? [] : [`${changed.unmatchedFiles.length} changed source file${changed.unmatchedFiles.length === 1 ? ' is' : 's are'} ${changed.note}: ${changed.unmatchedFiles.slice(0, 10).join(', ')}${changed.unmatchedFiles.length > 10 ? ', …' : ''}`];

/**
 * What the selection alone says: the status machine run over the probed claims
 * only, reduced to the two fields a caller acts on. `computeStatus` without
 * `only` stays the answer for the whole file.
 */
export function scopedView({ probedClaims, ...statusInput }) {
  const { state, next } = computeStatus({ ...statusInput, only: probedClaims });
  return { state, next };
}

/** The human lines for a scoped run: the selection first, then what the rest of the file says. */
export function renderScopedView(scope, view, whole) {
  const n = scope.probedCount;
  const lines = [`scope:    ${view.state} over ${n} selected claim${n === 1 ? '' : 's'}; next: [${view.next.action}] ${view.next.command}`, `why:      ${view.next.why}`];
  if (whole.state !== view.state || whole.next.why !== view.next.why) lines.push(`rest of the file: ${whole.state}; next: [${whole.next.action}] ${whole.next.command} (${whole.next.why})`);
  return lines;
}
