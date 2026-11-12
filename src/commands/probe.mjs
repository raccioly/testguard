import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadClaims, defaultClaimsPath, claimsSourceOf } from '../claims/load.mjs';
import { probe } from '../probe/probe.mjs';
import { writeSpecDoc, readSpecDoc } from '../evidence/writer.mjs';
import { gate } from '../baseline/baseline.mjs';
import { renderRecord, renderSummary, sortForReport, PROVISIONAL_WARNING, renderOriginPolicy } from '../render.mjs';
import { computeStatus } from '../status/status.mjs';
import { resolveChangedRef, resolveAutoChangedRef, withChangedRef } from '../gate/changed.mjs';
import { costReport, renderCost } from '../probe/cost.mjs';
import { progressMode, stageReporter, clearStageLine, recordEvent, isProgressMode, progressStream } from '../probe/progress.mjs';
import { validate } from '../../spec/lib/validate.mjs';
import { createCommandBudget, parseCommandBudget } from '../command-budget.mjs';
import { originPolicyRequest, evaluateOriginPolicy } from '../probe/origin-policy.mjs';
import { assertionPolicyRequest, evaluateAssertionPolicy, renderAssertionPolicy, isWeakKill } from '../probe/assertion-policy.mjs';
import { readNativeTestUniverse } from '../probe/universe.mjs';
import { originPolicyInputsFresh } from '../probe/policy-freshness.mjs';
import { runnerOptions } from './runner-options.mjs';
import { PreconditionError } from '../probe/precondition-error.mjs';
import { resolveFaultWorkers } from '../probe/fan-out.mjs';
import { availableParallelism } from 'node:os';
import { computeAdvice, renderAdvice } from '../status/advice.mjs';
import { resolveProbeScope } from '../probe/scope.mjs';
import { repoRoot, headSha } from '../git.mjs';
import { selectByChange, measuredScope, renderNoSelection, renderUnmatched, scopedView, renderScopedView } from './probe-scope.mjs';
import { claimResults } from '../probe/claim-results.mjs';
import { partialExit, partialEvidencePath, isNotReached } from '../probe/partial-budget.mjs';
import { convergeRequest, mergeEvidence, staleCarried } from '../evidence/carry.mjs';
export const provisionalEvidencePath = (projectDir) => join(projectDir, '.testguard', 'evidence-provisional.json');

export const evidencePath = (projectDir) => join(projectDir, '.testguard', 'evidence.json');
export const baselinePath = (projectDir) => join(projectDir, '.testguard', 'baseline.json');

/**
 * What `--changed auto` does with the base it found (#270). A base that
 * resolves narrows the probe; none, or one that does not resolve here (a
 * shallow CI checkout), is a full probe — never a skip — and the second says
 * how to fix it. `warn` lines are printed even under --quiet.
 */
export function autoChangedDecision(detected, resolves, { noFullFallback = false, skip = false } = {}) {
  if (detected && resolves) return { changed: detected.ref, message: `--changed auto: comparing against ${detected.ref} (${detected.from})`, warn: false };
  const why = detected
    ? `${detected.ref} (${detected.from}) does not resolve here; fetch it (GitHub Actions: actions/checkout with fetch-depth: 0)`
    : 'no base to compare against (no CI base branch, no remote default branch, no upstream)';
  // A hook never starts a full probe (#293): skip, or refuse, and say what to run instead.
  if (skip) return { changed: undefined, skip: true, message: `testguard: --changed auto found ${detected ? 'a base that ' + why : why}, so nothing was probed; CI and the nightly job probe this change. To probe it here: testguard probe --changed <base-branch>` };
  if (noFullFallback) return { changed: undefined, refuse: true, message: `--changed auto: ${why}, and --no-full-fallback refuses to probe every claim instead; pass --changed <ref>` };
  if (detected) return { changed: undefined, message: `--changed auto: ${detected.ref} (${detected.from}) does not resolve here, so every claim is probed; fetch it (GitHub Actions: actions/checkout with fetch-depth: 0) to probe only the change`, warn: true };
  return { changed: undefined, message: '--changed auto: no base to compare against (no CI base branch, no remote default branch, no upstream), so every claim is probed', warn: true };
}

/**
 * The evidence files a probe may carry verdicts forward from (#270): its own
 * output file, and for a partial run (--claim, --changed) the canonical
 * evidence of the last full probe too. None under --no-reuse.
 */
export function reuseSources({ outPath, canonical, partial, noReuse }) {
  if (noReuse) return [];
  return [...new Set([outPath, ...(partial ? [canonical] : [])])];
}

/** One line on how wide the run was and what its guard cost, for a fan-out. */
export function renderFanOut(run) {
  if (!(run.faultWorkers > 1)) return undefined;
  const m = run.measurements ?? {};
  const how = run.faultWorkersSource === 'auto' ? `auto, ${run.cpus} CPUs` : run.faultWorkersSource ?? 'requested';
  const s = (ms) => `${((ms ?? 0) / 1000).toFixed(1)}s`;
  return `fan-out: ${run.faultWorkers} faults at a time (${how}); ${m.aloneConfirmRuns ?? 0} kill${m.aloneConfirmRuns === 1 ? '' : 's'} confirmed by a run alone (${s(m.aloneConfirmMs)}), ${m.remeasuredFaults ?? 0} fault${m.remeasuredFaults === 1 ? '' : 's'} measured again alone (${s(m.remeasureMs)}).`;
}

/** The speed advice for the run that just finished: the status rules, with the change measured from the base `--changed auto` would use. */
function probeAdvice({ projectDir, claims, evidence, scoped, version, cpus }) {
  let changed;
  if (!scoped) {
    try {
      const auto = resolveAutoChangedRef({ projectDir });
      const scope = auto && resolveProbeScope({ projectDir, claims, ref: auto.ref, timeoutMs: 10_000 });
      if (scope && scope.outcome !== 'undetermined') changed = { selected: scope.selected.length, total: claims.claims.length, ref: auto.ref };
    } catch { changed = undefined; }
  }
  let root;
  try { root = repoRoot(projectDir); } catch { root = undefined; }
  return computeAdvice({ evidence, cpus, changed, root, toolVersion: version });
}

/** The evidence line of a scoped run that updated the canonical evidence (#293). */
export function renderConverged({ outPath, measured, selection, converged }) {
  const stale = converged.stale.length ? `; ${converged.stale.length} kept unchanged with inputs that no longer match, still stale: ${converged.stale.slice(0, 5).join(', ')}${converged.stale.length > 5 ? ', …' : ''}` : '';
  return `evidence: ${outPath} (converged: ${measured} measured, ${selection}; ${converged.carried} carried from ${converged.from} with unchanged inputs and no run, so the environment was not re-checked for them${stale})`;
}

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
  if ((values['no-full-fallback'] || values['skip-without-base']) && values.changed !== 'auto') {
    io.err(`--${values['no-full-fallback'] ? 'no-full-fallback' : 'skip-without-base'} needs --changed auto: only a base TestGuard looks for itself can be missing`);
    return 3;
  }
  if (values['skip-without-base'] && values.json) {
    io.err('--skip-without-base cannot be combined with --json: a skipped run has no document to print; use --no-full-fallback for a JSON refusal');
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
  // `--changed auto` (#270): the base found offline, as a pre-push hook and a
  // CI job need it. Nothing to compare against is a full probe, never a skip.
  if (values.changed === 'auto') {
    const detected = resolveAutoChangedRef({ projectDir });
    const decision = autoChangedDecision(detected, Boolean(detected && headSha(repoRoot(projectDir), detected.ref)), { noFullFallback: values['no-full-fallback'], skip: values['skip-without-base'] });
    // #293: a hook never starts a full probe. No base is a skip (exit 0: CI and
    // the nightly job are the gate) or a refusal, said in one line.
    if (decision.skip) { io.err(decision.message); return 0; }
    if (decision.refuse) throw new PreconditionError(decision.message, 'no-base');
    if (decision.message && (decision.warn || !values.quiet)) io.err(decision.message);
    values = { ...values, changed: decision.changed };
  }
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
  const canonicalPath = evidencePath(projectDir);
  // Convergence (#293): a scoped run with a determined selection updates the
  // canonical evidence. Until the probe says its records may be carried, the
  // run writes where a partial run always has.
  const request = convergeRequest({ scoped: Boolean(only), provisional, refExplicit: values.ref !== undefined, noReuse: values['no-reuse'] === true, out: values.out ? resolve(values.out) : undefined, canonical: canonicalPath, canonicalExists: existsSync(canonicalPath) });
  let carryFrom;
  let convergeReason = request.reason;
  if (request.converge) {
    try { carryFrom = readSpecDoc('evidence', canonicalPath); }
    catch (e) { convergeReason = `the canonical evidence cannot be read (${e.message.split('\n')[0]})`; }
  }
  let carryResult;
  const partialPath = join(projectDir, '.testguard', 'evidence-partial.json');
  let outPath = values.out && !(only && resolve(values.out) === canonicalPath) ? resolve(values.out) : only ? partialPath : provisional ? provisionalEvidencePath(projectDir) : canonicalPath;
  if (provisional && !values.quiet) io.err(PROVISIONAL_WARNING(confirmRuns));
  const discoveryNoted = new Set();
  // A partial run (--claim, --changed) also reuses the last full probe's
  // verdicts: the canonical evidence, under the same reuse rule (#270). That is
  // what makes the pre-push path cheap.
  const previousPaths = reuseSources({ outPath, canonical: evidencePath(projectDir), partial: Boolean(only), noReuse: values['no-reuse'] }).filter((path) => existsSync(path));
  const previous = previousPaths.map((path) => readSpecDoc('evidence', path));
  const basePath = values.baseline ? resolve(values.baseline) : baselinePath(projectDir);
  const baseline = existsSync(basePath) ? readSpecDoc('baseline', basePath) : undefined;

  const probed = await probe({
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
    ...(carryFrom ? { carry: { document: carryFrom, done: (result) => { carryResult = result; } } } : {}),
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
  const exhausted = probed.run.budget?.exhausted === true;
  // What this run measured; the findings gate and the per-claim results read
  // only these, so a scoped run's exit keeps meaning "the selection".
  const measured = probed.records;
  let evidence = probed;
  let converged;
  if (carryFrom && !exhausted) {
    if (!carryResult?.compatible) convergeReason = `the canonical evidence cannot be carried: ${carryResult?.reason ?? 'the probe decided nothing'}`;
    else {
      evidence = mergeEvidence({ measured: probed, canonical: carryFrom, decisions: carryResult.decisions, claims, scope: { selectedClaims: [...new Set(measured.map((r) => r.claim.id))], ...(requested ? { requestedClaims: requested } : {}), ...(changedScope ? { changed: { ref: changedScope.ref, base: changedScope.base, head: changedScope.head, ...(changedScope.includeDirty ? { includeDirty: true } : {}) } } : {}) } });
      outPath = canonicalPath;
      converged = { from: carryFrom.run.id, carried: evidence.run.reuse.carried ?? 0, stale: staleCarried(evidence) };
    }
  } else if (carryFrom && exhausted) convergeReason = 'the command budget ran out';
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
  // Another command may have written the canonical file while this one ran
  // (two sessions on one machine): merging over it would lose what it
  // measured. The partial file keeps this run's records instead.
  if (converged) {
    let current;
    try { current = readSpecDoc('evidence', canonicalPath).run.id; } catch { current = undefined; }
    if (current !== carryFrom.run.id) {
      evidence = probed;
      outPath = partialPath;
      converged = undefined;
      convergeReason = 'another command wrote the canonical evidence while this one ran';
    }
  }
  if (only && values.out && resolve(values.out) === canonicalPath && !converged && !exhausted) io.err(`warning: --out names the canonical evidence, but this scoped run did not converge (${convergeReason}); written to ${partialPath} instead`);
  const claimsSource = claimsSourceOf(projectDir, claimsPath);
  if (claimsSource) evidence.run.claimsSource = claimsSource;
  if (requireAssertionKill) evidence.assertionPolicy = evaluateAssertionPolicy(evidence.records);
  commandBudget?.assertOpen();
  writeSpecDoc('evidence', outPath, evidence);

  // The gate reads what was measured: a not-reached record always gates, and
  // counting it would hide how many findings the measured part really holds.
  const g = gate(exhausted ? measured.filter((r) => !isNotReached(r)) : measured, baseline, { severityFloor: values.severity });
  const policy = evidence.originPolicy;
  const weak = evidence.assertionPolicy;
  const incomplete = exhausted ? partialExit({ newGating: g.new.length, policyFailed: weak?.state === 'failed' }) : undefined;
  const exitCode = incomplete ? incomplete.exitCode : policy?.state === 'unavailable' ? 2 : policy?.state === 'failed' || weak?.state === 'failed' || g.new.length > 0 ? 1 : 0;
  const scope = measuredScope({ requested, changed: changedScope, records: measured });
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
    const doc = { ...status, ...(policy ? { originPolicy: policy } : {}), run: { id: evidence.run.id, evidence: outPath, provisional, records: measured.length, newSinceBaseline: g.new.length, exitCode, ...(probed.run.reuse ? { reuse: probed.run.reuse } : {}), ...(only ? { converged: converged ? { into: outPath, carriedFrom: converged.from, carried: converged.carried, stale: converged.stale } : { into: null, reason: convergeReason ?? 'not requested' } } : {}), ...(policy ? { originPolicy: policy } : {}), ...(weak ? { assertionPolicy: weak } : {}), ...(scope ? { scope: { ...scope, state: view.state, next: view.next } } : {}), ...(evidence.run.budget ? { budget: evidence.run.budget } : {}), ...(incomplete ? { failureKind: incomplete.failureKind, ...(incomplete.unprovenAtLeast !== undefined ? { unprovenAtLeast: incomplete.unprovenAtLeast } : {}) } : {}), claims: claimResults(measured) }, ...(values.cost ? { cost: costReport(measured, { run: probed.run }) } : {}) };
    const result = validate('status', doc);
    if (!result.ok) throw new Error(`probe JSON document does not conform: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    io.out(JSON.stringify(doc, null, 2));
    return exitCode;
  }
  if (!values.quiet && baseline) {
    io.out('');
    const tag = (r) => (isNotReached(r) ? '[not reached] ' : g.new.includes(r) ? '[NEW]      ' : g.baselined.includes(r) ? '[baseline] ' : '[below floor] ');
    for (const r of sortForReport(measured).filter((x) => x.verdict !== 'killed')) io.out('  ' + tag(r) + renderRecord(r, { provisional }));
  }
  io.out('');
  if (scope && !values.quiet) {
    const whole = computeStatus({ projectDir, toolVersion: version, includeDirty: values['include-dirty'], evidence: outPath, paths: statusPaths });
    for (const line of renderScopedView(scope, view, whole)) io.out(line);
    io.out('');
  }
  if (!values.quiet && !values.verbose) {
    const killed = measured.filter((r) => r.verdict === 'killed').length;
    if (killed) io.out(`  ${killed} killed (not listed; --verbose to see them)`);
  }
  io.out(renderSummary(measured, probed.run));
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
    io.out(renderCost(costReport(measured, { run: probed.run })));
    io.out('');
  }
  if (changedScope) for (const line of renderUnmatched(changedScope)) io.out(line);
  if (!values.quiet) {
    const fanOutLine = renderFanOut(evidence.run);
    if (fanOutLine) io.out(fanOutLine);
    // Where this run left speed on the table (#270), with the command.
    for (const line of renderAdvice(probeAdvice({ projectDir, claims, evidence, scoped: Boolean(scope), version, cpus: deps.cpus ?? availableParallelism() }))) io.out(line);
  }
  const selectionText = scope ? [scope.requestedClaims ? `${scope.requestedCount} claim${scope.requestedCount === 1 ? '' : 's'} requested` : null, scope.changed ? `${scope.selectedCount} selected by --changed ${scope.changed.ref}` : null, `${scope.probedCount} probed`].filter(Boolean).join(', ') + (scope.requestedClaims ? `: --claim ${scope.requestedClaims.join(',')}` : '') : '';
  if (converged) io.out(renderConverged({ outPath, measured: measured.length, selection: selectionText, converged }));
  else io.out(`evidence: ${outPath}${scope ? ` (partial: ${selectionText}; not the canonical evidence file${convergeReason ? `, which was not updated because ${convergeReason}` : ''})` : exhausted ? ' (incomplete: command budget exhausted; not the canonical evidence file)' : provisional ? ' (provisional; not the canonical evidence file)' : ''}`);
  if (provisional && !values.quiet) io.err(PROVISIONAL_WARNING(confirmRuns));
  return exitCode;
}
