import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadClaims, defaultClaimsPath } from '../claims/load.mjs';
import { probe } from '../probe/probe.mjs';
import { writeSpecDoc, readSpecDoc } from '../evidence/writer.mjs';
import { gate } from '../baseline/baseline.mjs';
import { renderRecord, renderSummary, sortForReport, PROVISIONAL_WARNING } from '../render.mjs';
import { computeStatus } from '../status/status.mjs';
import { resolveChangedRef, withChangedRef } from '../gate/changed.mjs';
import { costReport, renderCost } from '../probe/cost.mjs';
import { progressMode, stageReporter, clearStageLine, recordEvent, isProgressMode, progressStream } from '../probe/progress.mjs';
import { validate } from '../../spec/lib/validate.mjs';
export const provisionalEvidencePath = (projectDir) => join(projectDir, '.testguard', 'evidence-provisional.json');

export const evidencePath = (projectDir) => join(projectDir, '.testguard', 'evidence.json');
export const baselinePath = (projectDir) => join(projectDir, '.testguard', 'baseline.json');

/** Every repeated/comma-separated --claim value, in first-seen order. */
export function claimSelection(values) {
  if (values === undefined) return undefined;
  return [...new Set(values.flatMap((value) => value.split(',')).map((id) => id.trim()).filter(Boolean))];
}

/** Scope is invocation metadata, kept outside the evidence contract. */
export function partialScope(only, records) {
  if (!only) return undefined;
  const probedClaims = [...new Set(records.map((record) => record.claim.id))];
  return {
    requestedClaims: only,
    requestedCount: only.length,
    probedClaims,
    probedCount: probedClaims.length,
  };
}

export async function probeCommand({ projectDir, values, version }, io) {
  const confirmRuns = Number(values.confirm);
  const budgetMs = Number(values.budget);
  if (!Number.isInteger(confirmRuns) || confirmRuns < 1 || !Number.isInteger(budgetMs) || budgetMs < 1000) {
    io.err('--confirm must be a positive integer and --budget at least 1000');
    return 3;
  }
  if (values.progress && !isProgressMode(values.progress)) {
    io.err(`--progress must be one of auto, tty, plain, ndjson, none (got ${values.progress})`);
    return 3;
  }
  // Progress always goes to stderr, so --json keeps stdout parseable.
  const progress = progressMode({ explicit: values.progress, isTTY: process.stderr.isTTY, quiet: values.quiet, json: values.json });
  const progressTo = progressStream(process);
  const stageOut = stageReporter(progress, (s) => progressTo.write(s));
  const claims = loadClaims(values.claims ? resolve(values.claims) : defaultClaimsPath(projectDir));
  if (claims.claims.length === 0) {
    io.err('claims file declares no claims; nothing to verify');
    return 2;
  }
  const only = claimSelection(values.claim);
  if (only?.length === 0) {
    io.err('--claim must name at least one claim id');
    return 3;
  }
  // A --claim run is partial evidence; keep it away from the canonical file unless --out says otherwise.
  const provisional = confirmRuns < 3;
  // Provisional and partial runs never overwrite the canonical evidence: only confirmed, complete runs may feed a baseline.
  const outPath = values.out ? resolve(values.out) : only ? join(projectDir, '.testguard', 'evidence-partial.json') : provisional ? provisionalEvidencePath(projectDir) : evidencePath(projectDir);
  if (provisional && !values.quiet) io.err(PROVISIONAL_WARNING(confirmRuns));
  const discoveryNoted = new Set();
  const previous = !values['no-reuse'] && existsSync(outPath) ? readSpecDoc('evidence', outPath) : undefined;
  const basePath = values.baseline ? resolve(values.baseline) : baselinePath(projectDir);
  const baseline = existsSync(basePath) ? readSpecDoc('baseline', basePath) : undefined;

  const evidence = await probe({
    projectDir,
    claims,
    previous,
    confirmRuns,
    budgetMs,
    mode: values['in-place'] ? 'in-place' : 'worktree',
    ref: values.ref ?? 'HEAD',
    refExplicit: values.ref !== undefined,
    ignoreDirty: values['ignore-dirty'],
    serial: values.serial,
    onWarn: (m) => io.err(`warning: ${m}`),
    runnerCommand: values['runner-cmd'],
    runnerName: values.runner,
    nodeModules: values['node-modules'] ? resolve(values['node-modules']) : process.env.TESTGUARD_NODE_MODULES,
    python: values.python ? resolve(values.python) : undefined,
    only,
    escalate: !values['no-escalate'],
    toolVersion: version,
    includeDirty: values['include-dirty'],
    onStage: stageOut,
    onProgress: (r) => {
      // ndjson streams verdicts as they land; a watcher sees them without
      // waiting for the document at the end.
      if (progress === 'ndjson') progressTo.write(recordEvent(r));
      if (values.quiet || values.json) return;
      progressTo.write(clearStageLine(progress));
      // The discovery note is a property of the claim, not of each fault: say it once.
      const firstOfClaim = !discoveryNoted.has(r.claim.id);
      if (r.defenders.discovered) discoveryNoted.add(r.claim.id);
      if (values.verbose || r.verdict !== 'killed') io.out(renderRecord(r, { provisional, showDiscovered: firstOfClaim }) + (r.reusedFrom ? '  (reused)' : ''));
    },
  });
  writeSpecDoc('evidence', outPath, evidence);

  const g = gate(evidence.records, baseline, { severityFloor: values.severity });
  const scope = partialScope(only, evidence.records);
  if (values.json) {
    const status = withChangedRef(resolveChangedRef({ explicit: values.changed }), (changedRef) => computeStatus({ projectDir, toolVersion: version, changedRef, includeDirty: values['include-dirty'], evidence: outPath }), io.err);
    const doc = { ...status, run: { id: evidence.run.id, evidence: outPath, provisional, records: evidence.records.length, newSinceBaseline: g.new.length, exitCode: g.new.length > 0 ? 1 : 0, ...(scope ? { scope } : {}) }, ...(values.cost ? { cost: costReport(evidence.records) } : {}) };
    const result = validate('status', doc);
    if (!result.ok) throw new Error(`probe JSON document does not conform: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    io.out(JSON.stringify(doc, null, 2));
    return g.new.length > 0 ? 1 : 0;
  }
  if (!values.quiet && baseline) {
    io.out('');
    const tag = (r) => (g.new.includes(r) ? '[NEW]      ' : g.baselined.includes(r) ? '[baseline] ' : '[below floor] ');
    for (const r of sortForReport(evidence.records).filter((x) => x.verdict !== 'killed')) io.out('  ' + tag(r) + renderRecord(r, { provisional }));
  }
  io.out('');
  if (!values.quiet && !values.verbose) {
    const killed = evidence.records.filter((r) => r.verdict === 'killed').length;
    if (killed) io.out(`  ${killed} killed (not listed; --verbose to see them)`);
  }
  io.out(renderSummary(evidence.records, evidence.run) + (baseline ? ` ${g.new.length} new since baseline, ${g.baselined.length} baselined.` : ' No baseline.'));
  if (values.cost) {
    io.out('');
    io.out(renderCost(costReport(evidence.records)));
    io.out('');
  }
  io.out(`evidence: ${outPath}${scope ? ` (partial: ${scope.requestedCount} claim${scope.requestedCount === 1 ? '' : 's'} requested, ${scope.probedCount} probed: --claim ${scope.requestedClaims.join(',')}; not the canonical evidence file)` : provisional ? ' (provisional; not the canonical evidence file)' : ''}`);
  if (provisional && !values.quiet) io.err(PROVISIONAL_WARNING(confirmRuns));
  return g.new.length > 0 ? 1 : 0;
}
