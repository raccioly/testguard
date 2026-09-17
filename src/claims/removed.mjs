import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { git, GitError, repoRoot } from '../git.mjs';
import { readSpecDoc } from '../evidence/writer.mjs';
import { defaultIgnorePath } from '../gate/changed.mjs';
import { PreconditionError } from '../probe/worktree.mjs';

/**
 * A claim that no longer exists is invisible by construction: `probe` verifies
 * what is there, `gate` sees the source file covered by some other claim, and
 * `status` says clean. Deleting a claim is therefore cheaper than weakening
 * its fault — and `changedFaults` exists precisely because weakening was the
 * cheap escape. This closes the other half: removal is allowed, and recorded.
 *
 * Identities only. A fault whose text changed is `changedFaults`' business.
 */
const isExpired = (entry, now) => Boolean(entry.expires) && new Date(entry.expires).getTime() <= now.getTime();

/** The claims document as of `ref`, or null when the file did not exist there. */
export function claimsAt({ projectDir, ref, claimsPath }) {
  // git reports the repository root by its real path (/private/var on macOS);
  // a relative() that does not start from the same place yields `../../..`
  // and `git show` then fails as if the file had never existed.
  const root = repoRoot(realpathSync(resolve(projectDir)));
  // The file may not exist at this ref (or at all); realpath its DIRECTORY so
  // a missing file still resolves to a repository-relative path.
  const p0 = resolve(claimsPath);
  const abs = existsSync(p0) ? realpathSync(p0) : join(realpathSync(dirname(p0)), basename(p0));
  const rel = relative(root, abs).split('\\').join('/');
  if (rel.startsWith('..')) throw new PreconditionError(`the claims file ${claimsPath} is outside the repository at ${root}`);
  let text;
  try {
    text = git(['show', `${ref}:${rel}`], root);
  } catch (e) {
    if (e instanceof GitError) {
      // Distinguish "that ref is not a thing" (the caller's mistake) from
      // "the file did not exist yet" (nothing to compare, not an error).
      try {
        git(['rev-parse', '--verify', `${ref}^{commit}`], root);
      } catch {
        throw new PreconditionError(`cannot read ${ref}: no such commit`);
      }
      return null;
    }
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new PreconditionError(`the claims file at ${ref} is not valid JSON (${e.message})`);
  }
}

const index = (doc) => {
  const claims = new Map();
  for (const c of doc?.claims ?? []) claims.set(c.id, { statement: c.statement, severity: c.severity, faults: new Set((c.faults ?? []).map((f) => f.id)) });
  return claims;
};

/**
 * Compare claim and fault identities at `ref` with the working file.
 *
 * A removed id whose statement reappears verbatim under a new id is a
 * `renamed-claim`, not a removal: an ordinary rename must not read as an
 * escape, or the check becomes noise nobody acts on.
 */
export function computeRemovedClaims({ projectDir, ref, claimsPath, current, ignorePath, evidencePath, now = new Date(), toolVersion = '0.0.0' }) {
  const before = claimsAt({ projectDir, ref, claimsPath });
  const beforeIdx = index(before);
  const afterIdx = index(current);

  const iPath = ignorePath ?? defaultIgnorePath(projectDir);
  const ignore = existsSync(iPath) ? readSpecDoc('ignore', iPath) : { entries: [] };
  const excuses = ignore.entries
    .filter((e) => e.kind === 'claim' || e.kind === 'fault')
    .map((e) => ({ entry: e, expired: isExpired(e, now), used: [] }));

  const lastVerdict = new Map();
  if (evidencePath && existsSync(evidencePath)) {
    try {
      for (const r of readSpecDoc('evidence', evidencePath).records) lastVerdict.set(`${r.claim.id}/${r.subject.id}`, r.verdict);
    } catch {
      // Evidence that cannot be read must not stop the check; the verdict is
      // extra context, never the finding itself.
    }
  }

  const statementsAfter = new Map();
  for (const [id, c] of afterIdx) if (!beforeIdx.has(id)) statementsAfter.set(c.statement, id);

  const findings = [];
  for (const [id, c] of beforeIdx) {
    if (!afterIdx.has(id)) {
      const renamedTo = statementsAfter.get(c.statement);
      if (renamedTo) {
        findings.push({ kind: 'renamed-claim', claimId: id, renamedTo, severity: c.severity });
        continue;
      }
      const verdicts = [...c.faults].map((f) => lastVerdict.get(`${id}/${f}`)).filter(Boolean);
      findings.push({ kind: 'removed-claim', claimId: id, severity: c.severity, faults: [...c.faults].sort(), ...(verdicts.length ? { lastVerdicts: [...new Set(verdicts)].sort() } : {}) });
      continue;
    }
    for (const f of c.faults) {
      if (afterIdx.get(id).faults.has(f)) continue;
      const v = lastVerdict.get(`${id}/${f}`);
      findings.push({ kind: 'removed-fault', claimId: id, subjectId: f, severity: c.severity, ...(v ? { lastVerdicts: [v] } : {}) });
    }
  }

  // An excuse applies to a removal, never to a rename: a rename is already not a finding.
  const gating = [];
  for (const f of findings) {
    if (f.kind === 'renamed-claim') continue;
    const target = f.kind === 'removed-fault' ? `${f.claimId}/${f.subjectId}` : f.claimId;
    const active = excuses.find((e) => !e.expired && (e.entry.pattern === target || (f.kind === 'removed-fault' && e.entry.kind === 'claim' && e.entry.pattern === f.claimId)));
    if (active) {
      active.used.push(target);
      f.excusedBy = active.entry.pattern;
      continue;
    }
    const expired = excuses.find((e) => e.expired && (e.entry.pattern === target || (f.kind === 'removed-fault' && e.entry.kind === 'claim' && e.entry.pattern === f.claimId)));
    if (expired) {
      expired.used.push(target);
      f.expiredExcuse = expired.entry.pattern;
    }
    gating.push(f);
  }

  const order = { 'removed-claim': 0, 'removed-fault': 1, 'renamed-claim': 2 };
  findings.sort((a, b) => order[a.kind] - order[b.kind] || a.claimId.localeCompare(b.claimId) || (a.subjectId ?? '').localeCompare(b.subjectId ?? ''));

  return {
    ref,
    comparedAgainst: before ? 'claims-file' : 'nothing',
    findings,
    removed: gating,
    reliedOn: excuses.filter((e) => !e.expired && e.used.length).map((e) => ({ pattern: e.entry.pattern, reason: e.entry.reason, ...(e.entry.expires ? { expires: e.entry.expires } : {}), ids: e.used })),
    expired: excuses.filter((e) => e.expired && e.used.length).map((e) => ({ pattern: e.entry.pattern, reason: e.entry.reason, expires: e.entry.expires, ids: e.used })),
    toolVersion,
  };
}

export function renderRemoved(doc) {
  if (doc.comparedAgainst === 'nothing') return `no claims file at ${doc.ref}; nothing to compare`;
  const lines = [];
  for (const f of doc.findings) {
    const verdicts = f.lastVerdicts?.length ? ` — last ${f.lastVerdicts.length === 1 ? 'verdict' : 'verdicts'} ${f.lastVerdicts.join(', ')}` : '';
    if (f.kind === 'removed-claim') lines.push(`REMOVED    ${f.claimId} (${f.severity}, ${f.faults.length} fault${f.faults.length === 1 ? '' : 's'})${verdicts}${f.excusedBy ? `  [excused by ignore "${f.excusedBy}"]` : ''}${f.expiredExcuse ? `  [ignore "${f.expiredExcuse}" has EXPIRED]` : ''}`);
    else if (f.kind === 'removed-fault') lines.push(`REMOVED    ${f.claimId}/${f.subjectId} (${f.severity})${verdicts}${f.excusedBy ? `  [excused by ignore "${f.excusedBy}"]` : ''}${f.expiredExcuse ? `  [ignore "${f.expiredExcuse}" has EXPIRED]` : ''}`);
    else lines.push(`renamed    ${f.claimId} → ${f.renamedTo} (same statement; not a removal)`);
  }
  for (const r of doc.reliedOn) lines.push(`excused    ${r.ids.join(', ')}  by ignore "${r.pattern}": ${r.reason}${r.expires ? ` (expires ${r.expires})` : ''}`);
  for (const e of doc.expired) lines.push(`EXPIRED    ignore "${e.pattern}" (expired ${e.expires}) no longer excuses ${e.ids.join(', ')}`);
  if (doc.removed.length) {
    lines.push('', `${doc.removed.length} claim${doc.removed.length === 1 ? '' : 's'}/fault${doc.removed.length === 1 ? '' : 's'} present at ${doc.ref} no longer exist. Removing a claim is allowed — claims can be wrong, superseded or split — but it is the cheapest way to make a finding disappear, so it is never silent.`);
    lines.push('Either restore them, or add a `claim` entry to testguard.ignore.json with a reason a reviewer will accept.');
  } else if (doc.findings.length === 0) {
    lines.push(`every claim and fault present at ${doc.ref} still exists`);
  }
  return lines.join('\n');
}
