import { resolve } from 'node:path';
import { loadClaims, defaultClaimsPath } from '../claims/load.mjs';
import { scanAnnotations, reconcile } from '../claims/annotations.mjs';
import { resolveDefenders } from '../probe/runners/shared.mjs';
import { discoverDefendersDetailed } from '../probe/discover.mjs';
import { classifyDefenders } from '../probe/mocks.mjs';
import { computeRemovedClaims, renderRemoved } from '../claims/removed.mjs';
import { evidencePath } from './probe.mjs';
import { costReport, renderCost } from '../probe/cost.mjs';
import { readSpecDoc } from '../evidence/writer.mjs';
import { existsSync } from 'node:fs';
import { checkAnchors, renderAnchorChecks } from '../claims/anchors.mjs';
import { defenderSelection } from '../probe/attribution.mjs';

/** A selection warning is not a verdict: only a fresh probe can defend it. */
export function defenderNarrowing(projectDir, claims, records) {
  const prior = new Map(records.map((r) => [`${r.claim.id}/${r.subject.id}`, r]));
  const warnings = [];
  for (const c of claims.claims) {
    const inherited = c.defendedBy?.length ? resolveDefenders(projectDir, c.defendedBy) : [];
    for (const f of c.faults) {
      const record = prior.get(`${c.id}/${f.id}`);
      if (!Object.hasOwn(f, 'defendedBy') || record?.verdict !== 'killed') continue;
      const { requested } = defenderSelection(c, f);
      const resolved = requested.length ? resolveDefenders(projectDir, requested) : discoverDefendersDetailed(projectDir, f.file).canDetect;
      if (record.defenders.selectionSource === 'fault' && JSON.stringify(record.defenders.requested) === JSON.stringify(requested) && JSON.stringify([...record.defenders.resolved].sort()) === JSON.stringify([...resolved].sort())) continue;
      if (resolved.length < inherited.length && resolved.every((d) => inherited.includes(d))) {
        warnings.push({ claimId: c.id, faultId: f.id, inherited, resolved });
      }
    }
  }
  return warnings;
}

export async function claimsCommand({ projectDir, values, version }, io) {
  const path = values.claims ? resolve(values.claims) : defaultClaimsPath(projectDir);
  const claims = loadClaims(path);
  const annotations = scanAnnotations(projectDir);
  const drift = reconcile(claims, annotations);
  const anchorChecks = values['check-anchors']
    ? await checkAnchors(projectDir, claims, { python: values.python ? resolve(values.python) : undefined })
    : undefined;

  // A claim that disappeared is invisible to every other command; compare
  // identities against a reference when one is given.
  const removed = values.since
    ? computeRemovedClaims({ projectDir, ref: values.since, claimsPath: path, current: claims, ignorePath: values.ignore ? resolve(values.ignore) : undefined, evidencePath: evidencePath(projectDir), toolVersion: version })
    : undefined;

  // Cost is read back out of evidence the probe already wrote; it never runs a test.
  let cost;
  const ev = values.evidence ? resolve(values.evidence) : evidencePath(projectDir);
  const hasOverrides = claims.claims.some((c) => c.faults.some((f) => Object.hasOwn(f, 'defendedBy')));
  const prior = (values.cost || hasOverrides) && existsSync(ev) ? readSpecDoc('evidence', ev) : undefined;
  const narrowedDefenders = hasOverrides && prior ? defenderNarrowing(projectDir, claims, prior.records) : [];
  if (values.cost) {
    cost = prior ? costReport(prior.records, { run: prior.run }) : undefined;
    if (!cost && !values.json) io.err(`no evidence at ${ev} — run \`testguard probe\` first; cost is derived from the run durations it records`);
  }

  if (values.json) {
    io.out(JSON.stringify({ path, claims, annotations, drift, ...(hasOverrides ? { narrowedDefenders } : {}), ...(anchorChecks ? { anchorChecks } : {}), ...(removed ? { removed } : {}), ...(cost ? { cost } : {}) }, null, 2));
  } else {
    const annotated = new Set(drift.annotated);
    io.out(`${claims.claims.length} claims in ${path} — ${annotated.size} carry a @claim annotation in source (test files are not scanned)`);
    io.out('');
    const signalLines = [];
    for (const c of claims.claims) {
      const declared = c.defendedBy?.length > 0;
      const targets = [...new Set(c.faults.map((f) => f.file))];
      let cover;
      if (c.faults.some((f) => Object.hasOwn(f, 'defendedBy'))) {
        const selected = new Set();
        for (const f of c.faults) {
          const selection = defenderSelection(c, f);
          const defenders = selection.requested.length ? resolveDefenders(projectDir, selection.requested) : discoverDefendersDetailed(projectDir, f.file).canDetect;
          defenders.forEach((d) => selected.add(d));
          const m = classifyDefenders(projectDir, f.file, defenders);
          for (const s of m.signals) signalLines.push({ claim: c.id, target: f.file, ...s });
          io.out(`  ${c.id}/${f.id}: ${selection.selectionSource}${selection.requested.length ? '' : ' (discovery)'} — ${defenders.join(', ') || 'NO DEFENDER'}`);
        }
        cover = `${selected.size} selected defender${selected.size === 1 ? '' : 's'}`;
      } else if (declared) {
        const defenders = resolveDefenders(projectDir, c.defendedBy);
        const mocking = new Set();
        for (const t of targets) { const m = classifyDefenders(projectDir, t, defenders); m.mocking.forEach((f) => mocking.add(f)); for (const s of m.signals) signalLines.push({ claim: c.id, target: t, ...s }); }
        cover = defenders.length ? `${defenders.length} defender${defenders.length === 1 ? '' : 's'}${mocking.size ? ` (${mocking.size} mock the target)` : ''}` : 'NO DEFENDER';
      } else {
        const importing = new Set(); const mocking = new Set(); const can = new Set();
        for (const t of targets) { const d = discoverDefendersDetailed(projectDir, t); d.importing.forEach((f) => importing.add(f)); d.mocking.forEach((f) => mocking.add(f)); d.canDetect.forEach((f) => can.add(f)); for (const s of d.signals) signalLines.push({ claim: c.id, target: t, ...s }); }
        cover = can.size ? `${importing.size} import · ${mocking.size} mock · ${can.size} can detect` : importing.size ? `NO DEFENDER (${importing.size} import, all mock the target)` : 'NO DEFENDER';
      }
      io.out(`${annotated.has(c.id) ? '@ ' : '  '}${c.id.padEnd(14)} ${c.severity.padEnd(8)} ${c.source.kind.padEnd(10)} ${String(c.faults.length).padStart(2)} fault${c.faults.length === 1 ? ' ' : 's'}  ${cover.padEnd(12)}  ${c.statement}`);
    }
    if (signalLines.length) io.out('');
    for (const s of signalLines) {
      // The annotation's comment marker is the probed file's, not JavaScript's.
      const marker = s.file.endsWith('.py') ? '#' : '//';
      if (s.signal === 'mocked-never-asserted') io.out(`MOCKED-NEVER-ASSERTED  ${s.file} mocks ${s.target} and never asserts on it (${s.claim}) — assert on the mocked call, drive the real module, or annotate the mock \`${marker} unasserted: <why>\``);
      // An attribute patch does not remove a defender; saying it "mocks" the
      // module would tell the author the opposite of what happened.
      else if (s.signal === 'target-attribute-patched') io.out(`attribute-patched  ${s.file} defends ${s.target} but replaces ${s.reason} (${s.claim}) — a fault in those attributes is where it is least likely to notice`);
      else io.out(`unasserted (annotated)  ${s.file} mocks ${s.target}: ${s.reason} (${s.claim})`);
    }
    if (drift.undeclared.length || drift.stale.length) io.out('');
    for (const a of drift.undeclared) io.out(`UNDECLARED   @claim ${a.id} at ${a.file}:${a.line} has no entry in the claims file — a claim with no fault model`);
    for (const c of drift.stale) io.out(`STALE        ${c.id} is annotation-sourced but no source file carries @claim ${c.id}`);
    for (const w of narrowedDefenders) io.out(`NARROWED-DEFENDERS  ${w.claimId}/${w.faultId} selects ${w.resolved.length} of ${w.inherited.length} inherited defenders after a prior kill — re-probe; the old kill does not prove the narrower selection.`);
    if (removed) {
      io.out('');
      io.out(renderRemoved(removed));
    }
    if (cost) {
      io.out('');
      io.out(renderCost(cost));
    }
    if (anchorChecks) {
      io.out('');
      io.out(renderAnchorChecks(anchorChecks));
    }
  }
  return drift.undeclared.length || drift.stale.length || (removed?.removed.length ?? 0) > 0 || (anchorChecks?.invalid ?? 0) > 0 ? 1 : 0;
}
