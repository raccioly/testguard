import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readSpecDoc } from '../evidence/writer.mjs';
import { loadClaims, defaultClaimsPath } from '../claims/load.mjs';
import { gate } from '../baseline/baseline.mjs';
import { hashFile, sha256 } from '../util/hash.mjs';
import { resolveDefenders } from '../probe/runners/shared.mjs';
import { discoverDefenders } from '../probe/discover.mjs';
import { sortForReport } from '../render.mjs';
import { computeChangedGate, defaultIgnorePath } from '../gate/changed.mjs';
import { headSha, isAncestor } from '../git.mjs';

export const faultContentHash = (fault) => sha256(`${fault.find}\n${fault.replace}`);

const P = (projectDir) => ({
  claims: defaultClaimsPath(projectDir),
  evidence: join(projectDir, '.testguard', 'evidence.json'),
  provisional: join(projectDir, '.testguard', 'evidence-provisional.json'),
  baseline: join(projectDir, '.testguard', 'baseline.json'),
});

/**
 * The single answer to "where is this project and what happens next".
 * Reads the claims file, evidence, baseline and the working tree; never
 * trusts a cached verdict whose inputs have changed.
 */
export function computeStatus({ projectDir, toolVersion = '0.0.0', generatedAt = new Date().toISOString(), paths = P(projectDir), max = 20, changedRef, includeDirty = false }) {
  const rel = (p) => relative(projectDir, p) || '.';
  const doc = {
    schemaVersion: 1,
    tool: { name: 'testguard', version: toolVersion },
    generatedAt,
    state: 'no-claims',
    next: { action: 'scaffold', command: 'testguard scaffold <source-file>', why: 'No testguard.claims.json in this project. Scaffold proposes faults for a file; state what each guarantees, then probe.' },
    provisional: false,
    counts: { claims: 0, faults: 0 },
    stale: [],
    changedFaults: [],
    findings: [],
    notes: [],
    paths: {},
  };
  // ── Claim coverage of the change, when a reference is known ──
  // Computed before anything about evidence: a change that touches unclaimed
  // code is the finding every field report shared, and TestGuard is silent
  // about unclaimed code by construction. The claim is written first.
  // The reference is the caller's: this function never reads the environment,
  // so a library caller or a test in a temp directory is never surprised by CI.
  const ref = changedRef;
  let changes;
  if (ref) {
    const g = computeChangedGate({ projectDir, ref, includeDirty, toolVersion });
    changes = { ref: g.ref, base: g.base, includeDirty: g.includeDirty, changed: g.changed, evaluated: g.evaluated, excluded: g.excluded.length, uncovered: g.uncovered, reliedOn: g.reliedOn, expired: g.expired };
    doc.changes = changes;
    if (existsSync(defaultIgnorePath(projectDir))) doc.paths.ignore = rel(defaultIgnorePath(projectDir));
  }
  const unclaimedWhy = () => {
    const files = changes.uncovered.map((u) => u.file);
    return `${files.length} changed file${files.length === 1 ? '' : 's'} since ${changes.ref} carr${files.length === 1 ? 'ies' : 'y'} no claim and no excusing ignore entry: ${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}. State the claim before writing more code — TestGuard is silent about unclaimed code by construction.`;
  };

  if (!existsSync(paths.claims)) {
    if (changes?.uncovered.length) {
      const u = changes.uncovered[0];
      doc.next = { action: 'scaffold', command: `testguard scaffold ${u.file}`, why: `No testguard.claims.json in this project, and ${unclaimedWhy()}`, file: u.file };
    }
    return doc;
  }
  doc.paths.claims = rel(paths.claims);

  const claims = loadClaims(paths.claims);
  doc.counts.claims = claims.claims.length;
  doc.counts.faults = claims.claims.reduce((n, c) => n + c.faults.length, 0);
  const faultIndex = new Map();
  for (const c of claims.claims) for (const f of c.faults) faultIndex.set(`${c.id}/${f.id}`, { claim: c, fault: f });

  if (changes && changes.uncovered.length > 0) {
    const u = changes.uncovered[0];
    doc.state = 'unclaimed-changes';
    doc.next = { action: 'claim', command: u.suggestion, why: unclaimedWhy(), file: u.file };
    return doc;
  }

  const hasEvidence = existsSync(paths.evidence);
  const hasProvisional = existsSync(paths.provisional);
  if (hasProvisional) doc.paths.provisionalEvidence = rel(paths.provisional);
  if (!hasEvidence) {
    if (hasProvisional) {
      doc.state = 'provisional-only';
      doc.provisional = true;
      doc.next = { action: 'probe', command: 'testguard probe --confirm 3', why: 'Only provisional (sub-N) evidence exists; nothing is confirmed until the defenders agree three times.' };
    } else {
      doc.state = 'unprobed';
      doc.next = { action: 'probe', command: 'testguard probe', why: `${doc.counts.claims} claims / ${doc.counts.faults} faults have never been probed.` };
    }
    return doc;
  }
  doc.paths.evidence = rel(paths.evidence);
  const evidence = readSpecDoc('evidence', paths.evidence);
  const baseline = existsSync(paths.baseline) ? readSpecDoc('baseline', paths.baseline) : undefined;
  if (baseline) doc.paths.baseline = rel(paths.baseline);

  // ── Baseline provenance: informational, never a state. A baseline frozen
  // from a snapshot or a dirty tree names the PARENT of the commit that carries
  // its tests; once HEAD moved on, say so and name the way to re-stamp. ──
  if (baseline?.head) {
    const head = headSha(projectDir);
    if (head && head !== baseline.head) {
      if (baseline.snapshot || baseline.dirty) doc.notes.push(`baseline was frozen from a ${baseline.snapshot ? 'working-tree snapshot' : 'dirty tree'} at ${baseline.head.slice(0, 7)}; HEAD is ${head.slice(0, 7)} — it predates the commit that carries its tests. After a clean probe of HEAD reproduces the same fingerprints: testguard baseline --restamp`);
      else if (!isAncestor(projectDir, baseline.head, head)) doc.notes.push(`baseline head ${baseline.head.slice(0, 7)} is not an ancestor of HEAD ${head.slice(0, 7)} (rewritten or foreign history); re-probe and re-baseline if the fingerprints changed`);
    }
  }

  // ── Staleness: does the evidence still describe this claims file and this tree? ──
  const probed = new Map(evidence.records.map((r) => [`${r.claim.id}/${r.subject.id}`, r]));
  for (const key of faultIndex.keys()) if (!probed.has(key)) doc.stale.push(`fault ${key} has never been probed`);
  for (const [key, r] of probed) {
    const cur = faultIndex.get(key);
    if (!cur) { doc.stale.push(`fault ${key} was probed but is no longer in the claims file`); continue; }
    if (r.subject.contentHash && r.subject.contentHash !== faultContentHash(cur.fault)) {
      doc.changedFaults.push({ claimId: cur.claim.id, subjectId: cur.fault.id, previousVerdict: r.verdict, file: cur.fault.file });
      doc.stale.push(`fault ${key} changed since it was probed (was ${r.verdict})`);
    }
    const target = join(projectDir, cur.fault.file);
    if (existsSync(target) && hashFile(target) !== r.inputs.targetHash) doc.stale.push(`${cur.fault.file} changed since ${key} was probed`);
    const defenders = cur.claim.defendedBy?.length ? resolveDefenders(projectDir, cur.claim.defendedBy) : discoverDefenders(projectDir, cur.fault.file);
    for (const d of defenders) {
      const h = r.inputs.defenderHashes[d];
      if (!h) doc.stale.push(`${d} now defends ${key} but was not probed`);
      else if (existsSync(join(projectDir, d)) && hashFile(join(projectDir, d)) !== h) doc.stale.push(`${d} changed since ${key} was probed`);
    }
  }
  doc.stale = [...new Set(doc.stale)];

  // ── Findings, gated against the baseline ──
  const g = gate(evidence.records, baseline);
  const counts = {};
  for (const r of evidence.records) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  doc.counts.byVerdict = counts;
  const kills = evidence.records.filter((r) => r.verdict === 'killed');
  const coAuthored = kills.filter((r) => r.detail.independence?.class === 'co-authored').length;
  if (kills.length) doc.counts.killedCoAuthored = coAuthored;
  doc.counts.new = g.new.length + g.belowFloor.length;
  doc.counts.baselined = g.baselined.length;
  const ranked = sortForReport([...g.new, ...g.belowFloor, ...g.baselined]);
  doc.findings = ranked.slice(0, max).map((r) => ({
    fingerprint: r.fingerprint, claimId: r.claim.id, subjectId: r.subject.id, verdict: r.verdict,
    ...(r.detail.reason ? { reason: r.detail.reason } : {}), severity: r.claim.severity,
    ...(r.subject.file ? { file: r.subject.file } : {}), ...(r.rank ? { rank: r.rank.score } : {}),
    isNew: !g.baselined.includes(r),
  }));

  // ── State and next ──
  const changedSurvivor = doc.changedFaults.find((c) => c.previousVerdict !== 'killed');
  if (changedSurvivor) {
    doc.state = 'evidence-stale';
    doc.next = {
      action: 'review-fault-change',
      command: `testguard probe --claim ${changedSurvivor.claimId} --include-dirty`,
      why: `Fault ${changedSurvivor.claimId}/${changedSurvivor.subjectId} was edited after it ${changedSurvivor.previousVerdict}. Editing a claim is allowed, but a weakened fault is the cheapest way to make a finding vanish without a test — confirm the edit is a correction, then re-probe.`,
      target: { claimId: changedSurvivor.claimId, subjectId: changedSurvivor.subjectId, file: changedSurvivor.file, verdict: changedSurvivor.previousVerdict },
    };
    return doc;
  }
  if (doc.stale.length) {
    doc.state = 'evidence-stale';
    doc.next = { action: 'probe', command: 'testguard probe --include-dirty', why: `${doc.stale.length} input${doc.stale.length === 1 ? '' : 's'} changed since the evidence was taken: ${doc.stale.slice(0, 3).join('; ')}${doc.stale.length > 3 ? '; …' : ''}.` };
    return doc;
  }
  const top = doc.findings.find((f) => f.isNew);
  if (top) {
    doc.state = 'unproven';
    const cur = faultIndex.get(`${top.claimId}/${top.subjectId}`);
    const defenders = cur.claim.defendedBy?.length ? resolveDefenders(projectDir, cur.claim.defendedBy) : discoverDefenders(projectDir, cur.fault.file);
    const where = defenders[0] ?? `a new test file that imports ${cur.fault.file}`;
    const whyByVerdict = {
      survived: `${top.claimId}/${top.subjectId} (${top.severity}) survived: "${cur.claim.statement}" can be false with the suite green.`,
      nocover: `${top.claimId}/${top.subjectId} (${top.severity}) has no defender: no test file imports ${cur.fault.file}.`,
      unverifiable: `${top.claimId}/${top.subjectId} cannot be probed (${top.reason ?? 'anchor'}); fix the fault definition in testguard.claims.json, not the code.`,
      'fault-invalid': `${top.claimId}/${top.subjectId}'s replacement does not load; fix the fault definition.`,
      timeout: `${top.claimId}/${top.subjectId} makes the defenders hang; a hang is not a detection — write an assertion that fails on it.`,
      'flaky-defender': `${top.claimId}/${top.subjectId}'s defenders are not reliably green (${top.reason ?? ''}); fix the flake before any verdict can be trusted.`,
    };
    const fixClaim = ['unverifiable', 'fault-invalid'].includes(top.verdict);
    doc.next = {
      action: fixClaim ? 'probe' : 'write-test',
      command: fixClaim
        ? `edit ${top.claimId}/${top.subjectId} in testguard.claims.json, then: testguard probe --claim ${top.claimId} --include-dirty`
        : `write a test in ${where} that fails on ${top.claimId}/${top.subjectId} and passes on HEAD, then: testguard admit ${defenders[0] ?? '<that test file>'} --claim ${top.claimId}`,
      why: whyByVerdict[top.verdict] ?? `${top.claimId}/${top.subjectId} is ${top.verdict}.`,
      target: { claimId: top.claimId, subjectId: top.subjectId, ...(top.file ? { file: top.file } : {}), verdict: top.verdict },
    };
    return doc;
  }
  doc.state = 'clean';
  const unprovenTotal = evidence.records.filter((r) => r.verdict !== 'killed').length;
  if (unprovenTotal > 0 && !baseline) {
    doc.next = { action: 'baseline', command: 'testguard baseline', why: `${unprovenTotal} unproven finding${unprovenTotal === 1 ? '' : 's'} with no baseline; freeze them so only new ones gate from here.` };
  } else {
    doc.next = { action: 'none', command: 'testguard probe', why: unprovenTotal ? `${unprovenTotal} baselined finding${unprovenTotal === 1 ? '' : 's'} remain; nothing new. Re-probe after changing code, tests or claims.` : 'Every claim is defended. Re-probe after changing code, tests or claims; add a claim for every new invariant.' };
  }
  return doc;
}

export function renderStatus(doc) {
  const lines = [`state: ${doc.state}${doc.provisional ? ' (provisional)' : ''} — ${doc.counts.claims} claims / ${doc.counts.faults} faults` + (doc.counts.byVerdict ? `; ${Object.entries(doc.counts.byVerdict).map(([k, v]) => `${v} ${k}`).join(', ')}; ${doc.counts.new ?? 0} new, ${doc.counts.baselined ?? 0} baselined` : '')];
  if (doc.changes) {
    const c = doc.changes;
    lines.push(`changes:  ${c.changed} file${c.changed === 1 ? '' : 's'} since ${c.ref}; ${c.evaluated} evaluated, ${c.excluded} excluded, ${c.uncovered.length} unclaimed`);
    for (const u of c.uncovered) lines.push(`UNCLAIMED ${u.file} (${u.kind}) → ${u.suggestion}`);
    for (const r of c.reliedOn) lines.push(`excused   ${r.files.join(', ')} by ignore "${r.pattern}": ${r.reason}`);
    for (const e of c.expired) lines.push(`EXPIRED   ignore "${e.pattern}" no longer excuses ${e.files.join(', ')}`);
  }
  for (const c of doc.changedFaults) lines.push(`CHANGED   ${c.claimId}/${c.subjectId} edited since it ${c.previousVerdict} (${c.file})`);
  for (const s of doc.stale.slice(0, 8)) lines.push(`stale     ${s}`);
  for (const n of doc.notes ?? []) lines.push(`note      ${n}`);
  lines.push(`next:     [${doc.next.action}] ${doc.next.command}`);
  lines.push(`why:      ${doc.next.why}`);
  return lines.join('\n');
}
