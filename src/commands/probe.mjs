import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadClaims, defaultClaimsPath, claimsSourceOf } from '../claims/load.mjs';
import { probe } from '../probe/probe.mjs';
import { writeSpecDoc, readSpecDoc } from '../evidence/writer.mjs';
import { gate } from '../baseline/baseline.mjs';
import { renderRecord, renderSummary, sortForReport, PROVISIONAL_WARNING, renderOriginPolicy } from '../render.mjs';
import { computeStatus } from '../status/status.mjs';
import { resolveChangedRef, withChangedRef } from '../gate/changed.mjs';
import { costReport, renderCost } from '../probe/cost.mjs';
import { progressMode, stageReporter, clearStageLine, recordEvent, isProgressMode, progressStream } from '../probe/progress.mjs';
import { validate } from '../../spec/lib/validate.mjs';
import { createCommandBudget, parseCommandBudget } from '../command-budget.mjs';
import { originPolicyRequest, evaluateOriginPolicy } from '../probe/origin-policy.mjs';
import { assertionPolicyRequest, evaluateAssertionPolicy, renderAssertionPolicy, isWeakKill } from '../probe/assertion-policy.mjs';
import { readNativeTestUniverse } from '../probe/universe.mjs';
import { originPolicyInputsFresh } from '../probe/policy-freshness.mjs';
import { runnerOptions } from './runner-options.mjs';
import { resolveFaultWorkers } from '../probe/fan-out.mjs';
import { availableParallelism } from 'node:os';
import { selectByChange, measuredScope, renderNoSelection, renderUnmatched, scopedView, renderScopedView } from './probe-scope.mjs';
import { claimResults } from '../probe/claim-results.mjs';
import { partialExit, partialEvidencePath, isNotReached } from '../probe/partial-budget.mjs';
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

/**
 * `deps` is a test seam, never a CLI surface: `budgetOptions` reaches the
 * command budget (an injected clock makes expiry deterministic) and `onStage`
 * sees every stage the probe starts.
 */
export async function probeCommand({ projectDir, values, version }, io, deps = {}) {
  let eligibleKinds;
  try { eligibleKinds = originPolicyRequest(values); }
  catch (e) { io.err(e.message); return 3; }
  let requireAssertionKill;
  try { requireAssertionKill = assertionPolicyRequest(values, 'probe'); }
  catch (e) { io.err(e.message); return 3; }
  const confirmRuns = Number(values.confirm);
  const budgetMs = Number(values.budget);
  const workers = Number(values.workers ?? 1);
  if (!Number.isSafeInteger(workers) || workers < 1) {
    io.err('--workers must be a positive safe integer');
    return 3;
  }
  // Fast by default (#270): auto from the machine unless the flag, the
  // environment or the explicit --serial says otherwise. Only the flag the
  // user typed counts as --serial, never the derived "one runner worker".
  const fanOut = resolveFaultWorkers({ flag: values['fault-workers'], env: process.env, serial: values.serial === true, inPlace: values['in-place'] === true, cpus: deps.cpus ?? availableParallelism() });
  if (fanOut.error) {
    io.err(fanOut.error);
    return 3;
  }
  const { faultWorkers } = fanOut;
  // Flag combinations that are wrong whatever the repository holds, refused before the claims file or the repository is read.
  if (values['in-place'] && values.ref !== undefined) {
    io.err('--ref needs a scratch worktree; drop --in-place');
    return 3;
  }
  if (values['include-dirty'] && values['in-place']) {
    io.err('--include-dirty applies to worktree mode; drop --in-place');
    return 3;
  }
  if (values['include-dirty'] && values.ref !== undefined) {
    io.err('--include-dirty snapshots the working tree; it cannot be combined with --ref');
    return 3;
  }
  if (values.changed !== undefined && (values.ref !== undefined || values['in-place'])) {
    io.err('--changed selects against the tree being probed, so it cannot be combined with --ref or --in-place');
    return 3;
  }
  if (values['fail-on-empty-selection'] && values.changed === undefined) {
    io.err('--fail-on-empty-selection needs --changed <ref>: only a change-based selection can come up empty');
    return 3;
  }
  const commandBudgetMs = parseCommandBudget(values['command-budget']);
  if (!Number.isInteger(confirmRuns) || confirmRuns < 1 || !Number.isInteger(budgetMs) || budgetMs < 1000) {
    io.err('--confirm must be a positive integer and --budget at least 1000');
    return 3;
  }
  if (commandBudgetMs === null) {
    io.err('--command-budget must be at least 1000 milliseconds');
    return 3;
  }
  const partialOnBudget = values['partial-on-budget'] === true;
  if (partialOnBudget && commandBudgetMs === undefined) {
    io.err('--partial-on-budget needs --command-budget <ms>: without a command budget there is nothing to run out');
    return 3;
  }
  if (partialOnBudget && values['require-origin'] !== undefined) {
    io.err('--partial-on-budget cannot be combined with --require-origin: the origin policy needs complete evidence and runs test discovery of its own, which is new work after the budget has run out');
    return 3;
  }
  const runner = runnerOptions(values);
  if (runner.error) {
    io.err(runner.error);
    return 3;
  }
  let commandBudget = createCommandBudget(commandBudgetMs, deps.budgetOptions);
  if (values.progress && !isProgressMode(values.progress)) {
    io.err(`--progress must be one of auto, tty, plain, ndjson, none (got ${values.progress})`);
    return 3;
  }
  // Progress always goes to stderr, so --json keeps stdout parseable.
  const progress = progressMode({ explicit: values.progress, isTTY: process.stderr.isTTY, quiet: values.quiet, json: values.json });
  const progressTo = progressStream(process);
  const stageOut = stageReporter(progress, (s) => progressTo.write(s));
  const claimsPath = values.claims ? resolve(values.claims) : defaultClaimsPath(projectDir);
  const claims = loadClaims(claimsPath);
  if (claims.claims.length === 0) {
    if (values['allow-empty'] && values.claim === undefined) {
      io.err('claims file declares no claims; verification skipped (--allow-empty); run gate to check changed-file coverage');
      if (values.json) {
        const doc = computeStatus({ projectDir, toolVersion: version, paths: {
          claims: values.claims ? resolve(values.claims) : defaultClaimsPath(projectDir),
          evidence: evidencePath(projectDir), provisional: provisionalEvidencePath(projectDir), baseline: baselinePath(projectDir),
        } });
        const result = validate('status', doc);
        if (!result.ok) throw new Error(`empty probe JSON document does not conform: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
        io.out(JSON.stringify(doc, null, 2));
      }
      return 0;
    }
    io.err('claims file declares no claims; nothing to verify');
    return 2;
  }
  const requested = claimSelection(values.claim);
  if (requested?.length === 0) {
    io.err('--claim must name at least one claim id');
    return 3;
  }
  let only = requested;
  let changedScope;
  if (values.changed !== undefined) {
    const selection = selectByChange({ projectDir, claims, ref: values.changed, includeDirty: values['include-dirty'], only: requested, failOnEmpty: values['fail-on-empty-selection'] });
    if (selection.outcome !== 'selected') {
      for (const line of renderNoSelection(selection, { failOnEmpty: values['fail-on-empty-selection'] })) (selection.outcome === 'undetermined' || values.json ? io.err : io.out)(line);
      if (values.json) {
        // No probe ran: the status of the project as it is, plus the scope that explains why. An undetermined change never names a ref the status could not resolve.
        const status = withChangedRef(selection.outcome === 'undetermined' ? null : resolveChangedRef({ explicit: values.changed, projectDir }), (changedRef) => computeStatus({
          projectDir, toolVersion: version, changedRef, includeDirty: values['include-dirty'],
          paths: { claims: claimsPath, evidence: evidencePath(projectDir), provisional: provisionalEvidencePath(projectDir), baseline: values.baseline ? resolve(values.baseline) : baselinePath(projectDir) },
        }), io.err);
        const doc = { ...status, run: { exitCode: selection.exitCode, scope: selection.scope } };
        const result = validate('status', doc);
        if (!result.ok) throw new Error(`probe JSON document does not conform: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
        io.out(JSON.stringify(doc, null, 2));
      }
      return selection.exitCode;
    }
    only = selection.only;
    changedScope = selection.changed;
  }
  // A --claim or --changed run is partial evidence; keep it away from the canonical file unless --out says otherwise.
  const provisional = confirmRuns < 3;
  // Provisional and partial runs never overwrite the canonical evidence: only confirmed, complete runs may feed a baseline.
  let outPath = values.out ? resolve(values.out) : only ? join(projectDir, '.testguard', 'evidence-partial.json') : provisional ? provisionalEvidencePath(projectDir) : evidencePath(projectDir);
  if (provisional && !values.quiet) io.err(PROVISIONAL_WARNING(confirmRuns));
  const discoveryNoted = new Set();
  // A partial run (--claim, --changed) also reuses the last full probe's
  // verdicts: the canonical evidence, under the same reuse rule (#270). That is
  // what makes the pre-push path cheap.
  const previousPaths = values['no-reuse'] ? [] : [...new Set([outPath, ...(only ? [evidencePath(projectDir)] : [])])].filter((path) => existsSync(path));
  const previous = previousPaths.map((path) => readSpecDoc('evidence', path));
  const basePath = values.baseline ? resolve(values.baseline) : baselinePath(projectDir);
  const baseline = existsSync(basePath) ? readSpecDoc('baseline', basePath) : undefined;

  const evidence = await probe({
    projectDir,
    claims,
    previous,
    confirmRuns,
    budgetMs,
    workers,
    serial: values.serial || workers === 1,
    faultWorkers,
    faultWorkersSource: fanOut.source,
    ...(fanOut.cpus !== undefined ? { cpus: fanOut.cpus } : {}),
    commandBudget,
    partialOnBudget,
    mode: values['in-place'] ? 'in-place' : 'worktree',
    ref: values.ref ?? 'HEAD',
    refExplicit: values.ref !== undefined,
    ignoreDirty: values['ignore-dirty'],
    onWarn: (m) => io.err(`warning: ${m}`),
    runnerCommand: runner.runnerCommand,
    runnerName: values.runner,
    nodeModules: values['node-modules'] ? resolve(values['node-modules']) : process.env.TESTGUARD_NODE_MODULES,
    python: runner.python,
    typecheck: values.typecheck,
    only,
    escalate: !values['no-escalate'],
    toolVersion: version,
    includeDirty: values['include-dirty'],
    onStage: (event) => { stageOut?.(event); deps.onStage?.(event); },
    onProgress: (r) => {
      // ndjson streams verdicts as they land; a watcher sees them without
      // waiting for the document at the end.
      if (progress === 'ndjson') progressTo.write(recordEvent(r));
      if (values.quiet || values.json) return;
      progressTo.write(clearStageLine(progress));
      // The discovery note is a property of the claim, not of each fault: say it once.
      const firstOfClaim = !discoveryNoted.has(r.claim.id);
      if (r.defenders.discovered) discoveryNoted.add(r.claim.id);
      // A kill is normally a count. Under the policy, the ones it will fail on are named as they land.
      if (values.verbose || r.verdict !== 'killed' || (requireAssertionKill && isWeakKill(r))) io.out(renderRecord(r, { provisional, showDiscovered: firstOfClaim }) + (r.reusedFrom ? '  (reused)' : ''));
    },
  });
  // Every fault was either measured or reported as not reached, so what is
  // left (policy evaluation, one write) is no new measurement: the deadline
  // has done its job and a document that exists is never thrown away.
  const exhausted = evidence.run.budget?.exhausted === true;
  if (partialOnBudget) commandBudget = undefined;
  if (exhausted) {
    const canonical = evidencePath(projectDir);
    if (values.out && resolve(values.out) === canonical) io.err(`warning: the command budget ran out, so the document is incomplete and was written to ${partialEvidencePath(projectDir)} instead of the canonical ${canonical}`);
    outPath = values.out && resolve(values.out) !== canonical ? resolve(values.out) : partialEvidencePath(projectDir);
  }
  commandBudget?.assertOpen();
  if (eligibleKinds) {
    let universe;
    // Custom commands carry a static universe, which cannot establish this
    // native policy boundary. Discovery failures are unavailability, not kills.
    if (!runner.runnerCommand) {
      try {
        universe = await readNativeTestUniverse({
          projectDir, sourceDir: projectDir, runnerName: values.runner,
          python: runner.python,
          budgetMs: commandBudget?.runBudget(budgetMs) ?? budgetMs,
          budgetFor: () => commandBudget?.runBudget(budgetMs) ?? budgetMs,
          assertOpen: () => commandBudget?.assertOpen(),
        });
      } catch { /* An absent binding can never pass policy. */ }
    }
    commandBudget?.assertOpen();
    const currentClaims = loadClaims(values.claims ? resolve(values.claims) : defaultClaimsPath(projectDir));
    const fresh = originPolicyInputsFresh({ projectDir, claims: currentClaims, evidence, universe });
    evidence.originPolicy = evaluateOriginPolicy({ claims: currentClaims, evidence, eligibleKinds, fresh });
  }
  const claimsSource = claimsSourceOf(projectDir, claimsPath);
  if (claimsSource) evidence.run.claimsSource = claimsSource;
  if (requireAssertionKill) evidence.assertionPolicy = evaluateAssertionPolicy(evidence.records);
  commandBudget?.assertOpen();
  writeSpecDoc('evidence', outPath, evidence);

  // The gate reads what was measured: a not-reached record always gates, and
  // counting it would hide how many findings the measured part really holds.
  const g = gate(exhausted ? evidence.records.filter((r) => !isNotReached(r)) : evidence.records, baseline, { severityFloor: values.severity });
  const policy = evidence.originPolicy;
  const weak = evidence.assertionPolicy;
  const incomplete = exhausted ? partialExit({ newGating: g.new.length, policyFailed: weak?.state === 'failed' }) : undefined;
  const exitCode = incomplete ? incomplete.exitCode : policy?.state === 'unavailable' ? 2 : policy?.state === 'failed' || weak?.state === 'failed' || g.new.length > 0 ? 1 : 0;
  const scope = measuredScope({ requested, changed: changedScope, records: evidence.records });
  const statusPaths = {
    claims: values.claims ? resolve(values.claims) : defaultClaimsPath(projectDir),
    evidence: outPath, provisional: provisionalEvidencePath(projectDir),
    baseline: values.baseline ? resolve(values.baseline) : baselinePath(projectDir),
  };
  // The status header is about the whole claims file. A scoped run also says what is true of the selection alone.
  const view = scope ? scopedView({ probedClaims: scope.probedClaims, projectDir, toolVersion: version, includeDirty: values['include-dirty'], evidence: outPath, paths: statusPaths }) : undefined;
  if (values.json) {
    const status = withChangedRef(resolveChangedRef({ explicit: values.changed, projectDir }), (changedRef) => computeStatus({
      projectDir, toolVersion: version, changedRef, includeDirty: values['include-dirty'], evidence: outPath,
      paths: {
        claims: values.claims ? resolve(values.claims) : defaultClaimsPath(projectDir),
        evidence: outPath, provisional: provisionalEvidencePath(projectDir),
        baseline: values.baseline ? resolve(values.baseline) : baselinePath(projectDir),
      },
    }), io.err);
    const doc = { ...status, ...(policy ? { originPolicy: policy } : {}), run: { id: evidence.run.id, evidence: outPath, provisional, records: evidence.records.length, newSinceBaseline: g.new.length, exitCode, ...(evidence.run.reuse ? { reuse: evidence.run.reuse } : {}), ...(policy ? { originPolicy: policy } : {}), ...(weak ? { assertionPolicy: weak } : {}), ...(scope ? { scope: { ...scope, state: view.state, next: view.next } } : {}), ...(evidence.run.budget ? { budget: evidence.run.budget } : {}), ...(incomplete ? { failureKind: incomplete.failureKind, ...(incomplete.unprovenAtLeast !== undefined ? { unprovenAtLeast: incomplete.unprovenAtLeast } : {}) } : {}), claims: claimResults(evidence.records) }, ...(values.cost ? { cost: costReport(evidence.records, { run: evidence.run }) } : {}) };
    const result = validate('status', doc);
    if (!result.ok) throw new Error(`probe JSON document does not conform: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    io.out(JSON.stringify(doc, null, 2));
    return exitCode;
  }
  if (!values.quiet && baseline) {
    io.out('');
    const tag = (r) => (isNotReached(r) ? '[not reached] ' : g.new.includes(r) ? '[NEW]      ' : g.baselined.includes(r) ? '[baseline] ' : '[below floor] ');
    for (const r of sortForReport(evidence.records).filter((x) => x.verdict !== 'killed')) io.out('  ' + tag(r) + renderRecord(r, { provisional }));
  }
  io.out('');
  if (scope && !values.quiet) {
    const whole = computeStatus({ projectDir, toolVersion: version, includeDirty: values['include-dirty'], evidence: outPath, paths: statusPaths });
    for (const line of renderScopedView(scope, view, whole)) io.out(line);
    io.out('');
  }
  if (!values.quiet && !values.verbose) {
    const killed = evidence.records.filter((r) => r.verdict === 'killed').length;
    if (killed) io.out(`  ${killed} killed (not listed; --verbose to see them)`);
  }
  io.out(renderSummary(evidence.records, evidence.run));
  // Its own line: the summary ends with the origins line, which is not a sentence to append to.
  if (exhausted) {
    const b = evidence.run.budget;
    io.out(`command budget of ${b.limitMs}ms exhausted: ${b.reached} of ${b.reached + b.notReached} faults reached, ${b.notReached} not reached (unverifiable, ${'not-reached-within-budget'}; they gate, so the unmeasured part cannot look clean).`);
    if (incomplete.unprovenAtLeast !== undefined) io.out(`at least ${incomplete.unprovenAtLeast} unproven in the measured part (a floor: the faults not reached are not counted).`);
  }
  io.out(baseline ? `${g.new.length} new since baseline, ${g.baselined.length} baselined.` : 'No baseline.');
  if (policy) io.out(renderOriginPolicy(policy, { basis: 'current' }));
  if (weak) io.out(renderAssertionPolicy(weak));
  if (values.cost) {
    io.out('');
    io.out(renderCost(costReport(evidence.records, { run: evidence.run })));
    io.out('');
  }
  if (changedScope) for (const line of renderUnmatched(changedScope)) io.out(line);
  io.out(`evidence: ${outPath}${scope ? ` (partial: ${[scope.requestedClaims ? `${scope.requestedCount} claim${scope.requestedCount === 1 ? '' : 's'} requested` : null, scope.changed ? `${scope.selectedCount} selected by --changed ${scope.changed.ref}` : null, `${scope.probedCount} probed`].filter(Boolean).join(', ')}${scope.requestedClaims ? `: --claim ${scope.requestedClaims.join(',')}` : ''}; not the canonical evidence file)` : exhausted ? ' (incomplete: command budget exhausted; not the canonical evidence file)' : provisional ? ' (provisional; not the canonical evidence file)' : ''}`);
  if (provisional && !values.quiet) io.err(PROVISIONAL_WARNING(confirmRuns));
  return exitCode;
}
