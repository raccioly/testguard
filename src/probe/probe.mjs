import { resetInterpreterCache } from './runners/python.mjs';
import { assertNotCancelled } from './runners/lifecycle.mjs';
import { performance } from 'node:perf_hooks';
import { existsSync, readFileSync, realpathSync as fsRealpathSync } from 'node:fs';
import { gitRaw } from '../git.mjs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { repoRoot as gitRoot, headSha, isDirty, snapshotWorkingTree } from '../git.mjs';
import { discoverDefendersDetailed } from './discover.mjs';
import { classifyDefenders } from './mocks.mjs';
import { detectContention, contentionWarning, fanOutWarning } from './contention.mjs';
import { availableParallelism } from 'node:os';
import { withScratchBase } from '../scratch-dir.mjs';
import { createScratch, inPlace, PreconditionError, writeBoundary } from './worktree.mjs';
import { UsageError } from './precondition-error.mjs';
import { BudgetExhaustedError } from '../command-budget.mjs';
import { completeRecords, budgetSummary, notReachedRecord, isNotReached } from './partial-budget.mjs';
import { applyContent, applyFault, locate } from './inject.mjs';
import { resolveDefenders, parseCommandTemplate } from './runners/shared.mjs';
import { selectRunner, discoverRunnerManifest, RUNNERS, OWNED_RUNNERS, partitionByRunner, mergeRuns, runnerLabel, runnerFor } from './runners/index.mjs';
import { classify, shouldStopEarly } from './classify.mjs';
import { blastRadius, rank } from './rank.mjs';
import { classifyIndependence } from './independence.mjs';
import { killKindReasonOf } from './kill-kind.mjs';
import { escalationStart, foldEscalationRun, escalationResult, flakeRate, killersFromRuns, subjectOf, isReusable, defenderSelection } from './attribution.mjs';
import { hashFile, sha256 } from '../util/hash.mjs';
import { fingerprint } from '../../spec/lib/fingerprint.mjs';
import { recordedOriginSummary } from '../../spec/lib/origins.mjs';
import { persistenceSignalsFor } from '../supply/persistence.mjs';
import { collectOwnedManifests, hashNativeTestUniverse, hashCustomCommandUniverse } from './universe.mjs';
import { createDependencyHasher, instrumentOf } from './dependencies.mjs';
import { createTypechecker, sameTypecheck } from './typecheck.mjs';
import { aloneDisagrees, contentionRoundDown, createBusyClock, createOverlapTracker, deferLastRun, mustConfirmAlone, needsSerialRemeasure, orderedEmitter, parseFaultWorkers, runPool, singleFlight } from './fan-out.mjs';


/** Is `child` the same file as `root`, or under it? Both must already be real paths. */
function isInside(root, child) {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** realpath when the path still exists; the path itself otherwise. Never throws. */
function realpathSync(p) {
  try {
    return fsRealpathSync(p);
  } catch {
    return p;
  }
}

function readRunnerVersion(projectDir, name = 'vitest') {
  try {
    return JSON.parse(readFileSync(createRequire(join(projectDir, 'noop.js')).resolve(`${name}/package.json`), 'utf8')).version;
  } catch {
    return undefined;
  }
}

/** Validate and order a partial claim selection without losing caller order. */
export function selectClaims(claims, only) {
  if (!only) return claims;
  if (only.length === 0) throw new UsageError('--claim must name at least one claim id');
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const unknown = only.filter((id) => !byId.has(id));
  if (unknown.length) throw new PreconditionError(`--claim: unknown claim id(s) ${unknown.join(', ')}`, 'claim-unknown');
  return only.map((id) => byId.get(id));
}

/**
 * May a measurement taken with `previous` fault workers stand in for one with
 * `current`? A serial measurement (one fault at a time, nothing contending)
 * may stand in for any fan-out; a fan-out never stands in for a serial run,
 * nor for a different fan-out, because its contention was different (#237).
 * Evidence written before the field existed was serial.
 */
export function sameFaultWorkers(previous = 1, current = 1, { serialRequested = false } = {}) {
  if (previous === 1) return true;
  // Every fan-out of this tool version is guarded the same way (every kill
  // rests on a run alone, GATE-SEMANTICS "Fault fan-out"), so its width is not
  // part of what was measured: a laptop at four and CI at two share evidence.
  // A run that asked for one fault at a time asked not to rely on it.
  return !(current === 1 && serialRequested);
}

/** Reuse cannot stand in for a measurement under a different worker policy. */
export function sameWorkerPolicy(previousRun, { workers = 1, serial = workers === 1, runnerCommand, faultWorkers = 1, serialRequested = false } = {}) {
  if (!sameFaultWorkers(previousRun?.faultWorkers, faultWorkers, { serialRequested })) return false;
  if (runnerCommand) return previousRun?.workers === undefined && !previousRun?.serial;
  return previousRun?.workers === (serial ? 1 : workers) && Boolean(previousRun?.serial) === serial;
}

/**
 * What the evidence says ran: the engine's name, the version it reported, and
 * where it was resolved from (`project`, `path`, `builtin`). A custom command
 * resolves nothing, so it claims no source.
 */
export function runnerRecord(name, version, source) {
  return { name, ...(version ? { version } : {}), ...(source ? { source } : {}) };
}

/**
 * Reuse cannot stand in for a measurement by a different runner. pytest and
 * unittest are one adapter and two engines; a global vitest of the same
 * version is a different binary from the project's. Evidence that recorded no
 * runner cannot vouch for this one.
 */
export function sameRunner(previousRun, current) {
  const recorded = previousRun?.runner;
  if (!recorded) return false;
  return recorded.name === current.name && recorded.version === current.version && recorded.source === current.source;
}

/**
 * May anything in `previous` be carried forward into this run at all? The
 * same N, the same worker policy, the same runner — and the same instrument:
 * the TestGuard version that decided the verdicts and the resolver/runner
 * configuration digest. Evidence from another version is readable, never
 * reusable: a newer tool may decide verdicts by different rules. The type
 * check is part of the instrument: a verdict measured without it cannot vouch
 * for a run that has it (a fault it would have refused), nor the reverse.
 */
export function reusableRun(previous, { confirmRuns, workers, serial, runnerCommand, runner, instrument, typecheck, faultWorkers = 1, serialRequested = false }) {
  return Boolean(previous)
    && previous.run.confirmRuns === confirmRuns
    && sameWorkerPolicy(previous.run, { workers, serial, runnerCommand, faultWorkers, serialRequested })
    && sameRunner(previous.run, runner)
    && previous.tool?.version === instrument.toolVersion
    && previous.run.instrument?.toolVersion === instrument.toolVersion
    && previous.run.instrument?.digest === instrument.digest
    && sameTypecheck(previous.run.typecheck, typecheck);
}

/**
 * How much of a run was carried forward. A gate over authors who can write
 * the evidence file must not trust the reused share (GATE-SEMANTICS rule 8).
 */
export function reuseSummary(records) {
  const reused = records.filter((record) => record.reusedFrom).length;
  return { reused, measured: records.length - reused };
}

/**
 * Every record a reuse may carry forward, keyed by claim/fault, from one
 * previous document or several (#270: a `--changed` or `--claim` run reads its
 * own partial file and the canonical evidence of the last full probe). Each
 * document must pass `reusableRun` on its own; where two hold the same fault,
 * the one that finished later wins. Every record keeps the id of the run it
 * comes from.
 */
export function priorRecords(previous, policy) {
  const docs = (Array.isArray(previous) ? previous : [previous]).filter((doc) => reusableRun(doc, policy));
  docs.sort((a, b) => String(a.run.finishedAt ?? '').localeCompare(String(b.run.finishedAt ?? '')));
  const map = new Map();
  for (const doc of docs) for (const record of doc.records) map.set(`${record.claim.id}/${record.subject.id}`, { record, runId: doc.run.id });
  return map;
}

/** How the fan-out width was chosen, as the evidence records it (#270). */
export function fanOutPolicy({ faultWorkersSource, cpus } = {}) {
  if (!faultWorkersSource) return {};
  return { faultWorkersSource, ...(faultWorkersSource === 'auto' && cpus !== undefined ? { cpus } : {}) };
}

/** Did this run ask for one fault at a time? Then no fan-out may stand in for it. */
export const serialRequested = (faultWorkers, source) => faultWorkers === 1 && ['serial', 'flag', 'env'].includes(source);

/**
 * Probe every fault of every claim. Returns a spec-conformant evidence
 * document; writing it is the caller's job.
 */
export const probe = (options) => withScratchBase(options.scratchBase, () => probeBudgeted(options));

async function probeBudgeted(options) {
  const { partialOnBudget = false, commandBudget } = options;
  const ctx = { settled: new Map(), records: [], measurements: { elapsedMs: 0, runnerMs: 0, overheadMs: 0, runnerInvocations: 0, reuseBaselineRuns: 0 }, measuredStart: performance.now(), startedAt: new Date().toISOString(), runnerClock: createBusyClock(() => performance.now()) };
  if (!partialOnBudget) return measureProbe(options, ctx);
  if (!commandBudget) throw new UsageError('--partial-on-budget needs a command budget: pass --command-budget <ms>');
  let document;
  try {
    document = await measureProbe(options, ctx);
  } catch (error) {
    // By identity: only the budget's own expiry becomes a document. Every other
    // failure — including a precondition that merely coincides with the
    // deadline — is raised exactly as it is without the flag. measureProbe has
    // already restored and removed every tree.
    if (!(error instanceof BudgetExhaustedError)) throw error;
    return partialDocument(options, ctx);
  }
  // Every fault was reached; the deadline bounds measuring, so a complete
  // result stands even if the clock ran out while writing it.
  document.run.budget = budgetSummary(commandBudget.limitMs, document.records);
  return document;
}

/**
 * The document of a run whose command budget expired: every fault that was
 * fully measured keeps its record, every other fault is `not-reached`. Built
 * only after the scratch trees are gone, from what `measureProbe` published.
 */
function partialDocument(options, ctx) {
  const { claims, only, ref = 'HEAD', confirmRuns = 3, workers = 1, serial = workers === 1, faultWorkers = 1, runnerCommand, onProgress = () => {}, commandBudget, toolVersion = '0.0.0' } = options;
  const projectDir = realpathSync(resolve(options.projectDir));
  const faults = selectClaims(claims.claims, only).flatMap((claim) => claim.faults.map((fault) => ({ claim, fault })));
  const records = completeRecords(faults, ctx.settled, ({ claim, fault }) => notReachedRecord({ claim, fault, inputs: safeInputs(projectDir, fault, []), limitMs: commandBudget.limitMs }));
  // Whatever the ordered emitter had not published yet reaches the caller now, in order.
  for (const record of records.slice(ctx.records.length)) onProgress(record);
  const head = ctx.head ?? headSha(gitRoot(projectDir), ref);
  const { measurements, runnerClock } = ctx;
  measurements.runnerMs = runnerClock.totalMs;
  measurements.elapsedMs = performance.now() - ctx.measuredStart;
  measurements.overheadMs = measurements.elapsedMs - measurements.runnerMs;
  return {
    schemaVersion: 1,
    tool: { name: 'testguard', version: toolVersion },
    run: {
      id: `run-${ctx.startedAt.replace(/[-:.]/g, '').slice(0, 15)}`,
      startedAt: ctx.startedAt,
      finishedAt: new Date().toISOString(),
      repo: { head, dirty: isDirty(gitRoot(projectDir)), ...(ctx.snapshot ? { snapshot: ctx.snapshot } : {}), ...(ctx.ignoredDirty?.length ? { ignoredDirty: ctx.ignoredDirty } : {}) },
      ...(ctx.recordedRunner ? { runner: ctx.recordedRunner } : {}),
      ...(ctx.instrument ? { instrument: ctx.instrument } : {}),
      reuse: reuseSummary(records),
      ...(ctx.runnersUsed?.size > 1 ? { runners: [...ctx.runnersUsed].map(([n, v]) => ({ name: n, ...(v ? { version: v } : {}) })) } : {}),
      confirmRuns,
      measurements,
      ...(!runnerCommand ? { workers: serial ? 1 : workers } : {}),
      ...(serial && !runnerCommand ? { serial: true } : {}),
      ...((ctx.faultWorkers ?? faultWorkers) > 1 ? { faultWorkers: ctx.faultWorkers ?? faultWorkers } : {}),
      ...fanOutPolicy(options),
      ...(ctx.contention?.detected ? { contention: ctx.contention } : {}),
      ...(confirmRuns < 3 ? { provisional: true } : {}),
      mode: ctx.mode ?? options.mode ?? 'worktree',
      budget: budgetSummary(commandBudget.limitMs, records),
    },
    records,
    origins: recordedOriginSummary(records),
  };
}

async function measureProbe({
  projectDir,
  claims,
  confirmRuns = 3,
  mode = 'worktree',
  ref = 'HEAD',
  refExplicit = false,
  ignoreDirty = false,
  workers = 1,
  serial = workers === 1,
  faultWorkers = 1,
  faultWorkersSource,
  cpus,
  onWarn = () => {},
  budgetMs = 120_000,
  commandBudget,
  runnerCommand,
  runnerName = 'auto',
  nodeModules,
  python,
  only,
  includeDirty = false,
  onStage = () => {},
  escalate = true,
  scratchBase,
  toolVersion = '0.0.0',
  previous,
  onProgress = () => {},
  typecheck,
}, ctx) {
  if (!Number.isSafeInteger(workers) || workers < 1) throw new UsageError('workers must be a positive safe integer');
  if (parseFaultWorkers(faultWorkers) !== faultWorkers) throw new UsageError('fault workers must be a positive safe integer');
  // One mutable tree cannot hold two faults at once; the fan-out needs one
  // scratch worktree per fault in flight.
  if (mode === 'in-place' && faultWorkers > 1) throw new UsageError('--fault-workers above 1 needs one scratch worktree per fault in flight; drop --in-place');
  // Combinations that are wrong whatever the repository holds are usage (exit 3) and are refused first, so a
  // repository problem never hides the mistake in the request. What depends on the tree is a precondition (exit 2).
  if (mode === 'in-place' && ref !== 'HEAD') throw new UsageError('--ref needs a scratch worktree; drop --in-place');
  if (includeDirty && mode !== 'worktree') throw new UsageError('--include-dirty applies to worktree mode; drop --in-place');
  if (includeDirty && ref !== 'HEAD') throw new UsageError('--include-dirty snapshots the working tree; it cannot be combined with --ref');
  resetInterpreterCache(); // Cache only within this measurement, never across commands.
  const { measuredStart, startedAt, measurements, runnerClock } = ctx;
  // Runner time is wall-clock time with at least one runner executing: the
  // sum of the invocations when serial, their union under a fan-out.
  const timedRun = async (runner, opts) => {
    assertNotCancelled();
    runnerClock.start();
    measurements.runnerInvocations++;
    try { return await runner.run(opts); }
    finally { runnerClock.stop(); }
  };
  commandBudget?.assertOpen();
  // realpath: git reports the repository root by its real path (/private/var
  // on macOS, not /var); every relative() below must start from the same place.
  projectDir = realpathSync(resolve(projectDir));
  const root = gitRoot(projectDir);
  const boundary = writeBoundary({ repoRoot: root, nodeModules }); // as the run starts, before anything is linked or written
  const head = headSha(root, ref);
  ctx.head = head;
  if (!head) {
    if (ref === 'HEAD') throw new PreconditionError('repository has no commits; every verdict is tied to a commit', 'no-commits');
    throw new PreconditionError(`ref ${ref} does not resolve to a commit`, 'ref-unresolved');
  }

  const scopedClaims = selectClaims(claims.claims, only);
  const targets = [...new Set(scopedClaims.flatMap((c) => c.faults.map((f) => relative(root, join(projectDir, f.file)))))];
  if (mode === 'in-place' && isDirty(root, targets)) {
    throw new PreconditionError(`uncommitted changes in fault target files (${targets.join(', ')}); commit or stash them, or drop --in-place. Only the files faults are applied to must be clean — test files may be dirty, which is what makes --in-place usable while writing tests.`, 'dirty-tree');
  }

  // Worktree mode probes a commit, not the working tree. Uncommitted defender
  // or target edits would be silently absent — the same survivors, no hint why.
  // Refused for the IMPLICIT HEAD, which is the silent-mismatch trap. With an
  // explicit --ref the user has named the commit they mean (a pre-fix probe
  // in a post-mortem is the most valuable run there is); with --ignore-dirty
  // they have said they know. Both proceed with a warning that names the
  // files, and the evidence records what was ignored.
  let snapshot;
  let ignoredDirty = [];
  if (mode === 'worktree') {
    if (includeDirty) {
      if (isDirty(root)) { snapshot = snapshotWorkingTree(root); ctx.snapshot = snapshot; }
    } else {
      const watched = new Set(targets);
      const records = gitRaw(['status', '--porcelain=v1', '-z'], root).split('\0');
      const dirtyPaths = [];
      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        if (!record) continue;
        const status = record.slice(0, 2);
        dirtyPaths.push(record.slice(3));
        // Under -z, rename/copy records carry the destination in this record
        // and the source as the next NUL-delimited record. Watch both: either
        // side may be a declared defender, fault target, or config input.
        if (/[RC]/.test(status) && records[i + 1]) dirtyPaths.push(records[++i]);
      }
      let configuredFiles;
      // Use the same exact primary + owned native universes as measurement.
      // A dirty custom-named Playwright test or imported config helper must be
      // refused before the scratch tree silently substitutes HEAD's version.
      if (dirtyPaths.length && !runnerCommand) {
        const budgetFor = () => commandBudget?.runBudget(budgetMs) ?? budgetMs;
        const selected = await selectRunner({ projectDir, sourceDir: projectDir, python, name: runnerName, budgetMs: budgetFor(), budgetFor });
        commandBudget?.assertOpen();
        if (selected.error) throw new PreconditionError(`cannot verify dirty defender/config inputs because test discovery failed (${selected.error})`, 'discovery-failed');
        const manifests = new Map([[selected.runner, selected.manifest]]);
        const primaryIsPython = ['python', 'pytest', 'unittest'].includes(selected.runner.name);
        const owned = OWNED_RUNNERS.filter((candidate) => candidate !== selected.runner && !(candidate.name === 'python' && primaryIsPython));
        for (const candidate of owned) {
          const check = await candidate.check({ projectDir, sourceDir: projectDir, python, budgetMs: budgetFor(), budgetFor });
          commandBudget?.assertOpen();
          if (!check.ok) continue;
          try {
            manifests.set(candidate, await discoverRunnerManifest(candidate, check, projectDir, budgetFor()));
          } catch (error) {
            if (error instanceof BudgetExhaustedError) throw error;
            throw new PreconditionError(`cannot verify dirty defender/config inputs because ${candidate.name} discovery failed (${error.message})`, 'discovery-failed');
          }
        }
        configuredFiles = Object.freeze([...new Set([...manifests.values()].flatMap((manifest) => manifest.files))].sort());
        for (const manifest of manifests.values()) {
          for (const file of manifest.files) watched.add(relative(root, join(projectDir, file)));
          for (const config of manifest.configFiles) {
            if (!config.path.startsWith('@module/')) watched.add(relative(root, join(projectDir, config.path)));
          }
        }
      }
      for (const claim of scopedClaims) {
        for (const fault of claim.faults) {
          const { requested } = defenderSelection(claim, fault);
          const discovered = requested.length ? null : discoverDefendersDetailed(projectDir, fault.file, configuredFiles);
          const declared = requested.length ? resolveDefenders(projectDir, requested) : discovered.canDetect;
          for (const d of declared) watched.add(relative(root, join(projectDir, d)));
          for (const dependency of discovered?.dependencies ?? []) watched.add(relative(root, join(projectDir, dependency)));
          for (const g of requested) if (!g.includes('*')) watched.add(relative(root, join(projectDir, g)));
        }
      }
      for (const config of [
        'package.json', 'pnpm-workspace.yaml', 'pnpm-workspace.yml', 'lerna.json', 'nx.json', 'turbo.json', 'rush.json', 'workspace.json',
        ...['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].flatMap((ext) => [`vitest.config.${ext}`, `vite.config.${ext}`, `vitest.workspace.${ext}`, `jest.config.${ext}`, `playwright.config.${ext}`]),
        'vitest.workspace.json',
      ]) watched.add(relative(root, join(projectDir, config)));
      const dirty = dirtyPaths.filter((path) => watched.has(path));
      if (dirty.length && !refExplicit && !ignoreDirty) {
        throw new PreconditionError(`${dirty.length} defender/target file${dirty.length === 1 ? ' has' : 's have'} uncommitted changes (${dirty.join(', ')}); worktree mode probes HEAD (${head.slice(0, 7)}), so those changes would be silently ignored. Commit them, run with --include-dirty to probe the working tree, use --in-place, or --ignore-dirty if you mean HEAD as committed.`, 'dirty-tree');
      }
      if (dirty.length) {
        ignoredDirty = dirty.sort();
        ctx.ignoredDirty = ignoredDirty;
        onWarn(`${dirty.length} defender/target file${dirty.length === 1 ? ' has' : 's have'} uncommitted changes (${dirty.join(', ')}); probing ${ref === 'HEAD' ? `HEAD (${head.slice(0, 7)})` : `${ref} (${head.slice(0, 7)})`} as committed — the working-tree versions are NOT what is being probed. Recorded in the evidence as repo.ignoredDirty.`);
      }
    }
  }
  // Contention: name it before the first run, and record it, so a later
  // reader of a TIMEOUT or FLAKY-DEFENDER knows the machine was loaded.
  const contention = detectContention();
  ctx.contention = contention;
  // Other runners already busy: an automatic width is halved, because the
  // machine is not the probe's to divide (#270). A chosen width is kept.
  const roundedDown = contentionRoundDown({ faultWorkers, source: faultWorkersSource }, contention.detected);
  if (roundedDown !== faultWorkers) {
    onWarn(`other test runners are already running, so the automatic fault-worker count drops from ${faultWorkers} to ${roundedDown}; pass --fault-workers <n> to choose it yourself.`);
    faultWorkers = roundedDown;
  }
  ctx.faultWorkers = faultWorkers;
  if (contention.detected) onWarn(contentionWarning(contention, { serial, workers, custom: Boolean(runnerCommand), faultWorkers }));
  const selfLoad = fanOutWarning({ faultWorkers, workers, serial: serial || Boolean(runnerCommand), cpus: availableParallelism() });
  if (selfLoad) onWarn(selfLoad);

  const iso = mode === 'worktree' ? createScratch({ repoRoot: root, projectDir, ref: snapshot ?? ref, scratchBase, nodeModules }) : inPlace({ repoRoot: root, projectDir });
  ctx.mode = iso.mode;
  const isoReal = realpathSync(iso.projectDir);
  const extraTrees = []; // the fan-out's scratch trees beyond the first
  const records = ctx.records;
  let runnerVersion;
  let runnerSource;
  let recordedRunner;
  let primaryManifest;
  let instrument;
  let typechecker;
  let runner = RUNNERS[runnerName === 'auto' ? 'vitest' : runnerName];
  // A runner with more than one engine (Python: pytest or unittest) is recorded
  // by the engine that actually ran, never by the module's name. TestGuard does
  // not say pytest ran when the stdlib runner did.
  const engines = new Map();
  const labelOf = (r) => runnerLabel(r, engines);
  const runnersUsed = new Map(); // every runner that ran defenders, beyond the project runner
  ctx.runnersUsed = runnersUsed;
  try {
    const commandTemplate = runnerCommand ? parseCommandTemplate(runnerCommand) : undefined;
    if (!commandTemplate) {
      // An unresolvable runner is a precondition failure, not a flaky defender.
      const sel = await selectRunner({ projectDir: iso.projectDir, sourceDir: projectDir, python, name: runnerName, budgetMs, budgetFor: () => commandBudget?.runBudget(budgetMs) ?? budgetMs });
      commandBudget?.assertOpen();
      if (sel.error) {
        throw new PreconditionError(`test runner is not resolvable in the ${mode === 'worktree' ? 'scratch worktree' : 'project'} (${sel.error}). ` +
          (mode === 'worktree' ? 'If dependencies are missing, pass --node-modules <path>, or run with --in-place. Otherwise fix the discovery error above.' : 'If dependencies are missing, install them first. Otherwise fix the discovery error above.'), 'runner-unresolvable');
      }
      runner = sel.runner;
      runnerVersion = sel.version;
      runnerSource = sel.source;
      primaryManifest = sel.manifest;
      if (sel.engine) engines.set(sel.runner, sel.engine);
    }
    recordedRunner = runnerRecord(labelOf(runner), runnerVersion ?? readRunnerVersion(projectDir, runner.name), runnerSource);
    ctx.recordedRunner = recordedRunner;
    runnersUsed.set(recordedRunner.name, recordedRunner.version);
    // Files an owning runner (Playwright) claims run under it, whatever the
    // project runner is; it must resolve before the first such defender runs.
    const owned = OWNED_RUNNERS.filter((r) => r !== runner
      && !(r.name === 'python' && ['python', 'pytest', 'unittest'].includes(runner.name)));
    let ownedChecked = new Map();
    let manifests = new Map(primaryManifest ? [[runner, primaryManifest]] : []);
    if (!commandTemplate) {
      try {
        ({ ownedChecked, manifests } = await collectOwnedManifests(runner, primaryManifest, {
          projectDir: iso.projectDir, sourceDir: projectDir, python, budgetMs,
          budgetFor: () => commandBudget?.runBudget(budgetMs) ?? budgetMs,
          assertOpen: () => commandBudget?.assertOpen(),
        }));
      } catch (error) {
        if (error instanceof BudgetExhaustedError) throw error;
        throw new PreconditionError(`test discovery failed: ${error.message}`, 'discovery-failed');
      }
    }
    // Single-flight: two trees reaching a not-yet-checked owning runner at the
    // same moment share one check.
    const ownedChecking = new Map();
    const ensureOwned = async (r, file) => {
      if (!ownedChecked.has(r)) {
        await singleFlight(ownedChecking, r, async () => {
          ownedChecked.set(r, await r.check({ projectDir: iso.projectDir, sourceDir: projectDir, python, budgetMs: commandBudget?.runBudget(budgetMs) ?? budgetMs, budgetFor: () => commandBudget?.runBudget(budgetMs) ?? budgetMs }));
          commandBudget?.assertOpen();
        });
      }
      const c = ownedChecked.get(r);
      if (!c.ok) throw new PreconditionError(`${file} is a ${r.name} test (${r.name === 'python' ? 'it is a .py file' : `it lives under ${r.name}'s testDir`}) but ${r.name} is not resolvable for the ${mode === 'worktree' ? 'scratch worktree' : 'project'} (${c.message}).`, 'defender-misrouted');
      if (c.engine) engines.set(r, c.engine);
      runnersUsed.set(labelOf(r), c.version);
    };
    const ownerByFile = new Map();
    if (!commandTemplate) {
      for (const file of manifests.get(runner)?.files ?? []) ownerByFile.set(file, runner);
      for (const [owner, manifest] of manifests) {
        if (owner === runner) continue;
        for (const file of manifest.files) {
          const previousOwner = ownerByFile.get(file);
          if (previousOwner && previousOwner !== runner && previousOwner !== owner) {
            throw new PreconditionError(`${file} was listed by both ${previousOwner.name} and ${owner.name}; TestGuard cannot choose which configured runner owns it.`, 'defender-ambiguous');
          }
          // A per-file runner that natively lists a file owns it over a broad
          // project runner that also collected it. Membership, never filename
          // heuristics, makes that decision.
          ownerByFile.set(file, owner);
        }
      }
    }
    const allTests = Object.freeze((commandTemplate
      ? [...new Set([...runner.tests(iso.projectDir).filter((t) => !owned.some((r) => r.owns(iso.projectDir, t))), ...owned.flatMap((r) => r.tests(iso.projectDir))])]
      : [...ownerByFile.keys()]).sort());
    const testUniverseHash = commandTemplate
      ? hashCustomCommandUniverse(allTests, commandTemplate)
      : hashNativeTestUniverse(manifests);
    const baselineCache = new Map();
    const discoveryHashCache = new Map();
    // Hashes and parses are cached only where the tree cannot change between
    // faults: the scratch worktree. In place, the user's tree is live.
    const dependencyHasher = createDependencyHasher(iso.projectDir, { cache: iso.mode === 'worktree' });
    // The negative control is charged per (target file, defender set): two
    // claims over the same file with the same defenders ask the same question.
    // Promises, so two trees asking at once share one run.
    const controlCache = new Map();
    instrument = instrumentOf(iso.projectDir, toolVersion);
    ctx.instrument = instrument;
    // The type check's baseline comes before any fault: a tree that already
    // fails it cannot be used to judge a fault. Throws a precondition error.
    // Every fault's type check then runs while it is planned, on this first
    // tree and one at a time, so its incremental build-info is never shared
    // between trees and a fan-out type-checks exactly as a serial run does.
    if (typecheck !== undefined) {
      typechecker = await createTypechecker({ projectDir: iso.projectDir, command: typecheck, budgetMs: commandBudget?.runBudget(budgetMs) ?? budgetMs, scratchBase });
      commandBudget?.assertOpen();
    }
    const prior = priorRecords(previous, { confirmRuns, workers, serial, runnerCommand, runner: recordedRunner, instrument, typecheck: typechecker?.spec, faultWorkers, serialRequested: serialRequested(faultWorkers, faultWorkersSource) });
    const partitionConfigured = (files) => {
      if (commandTemplate) return partitionByRunner(iso.projectDir, files, runner);
      const groups = new Map([[runner, []]]);
      for (const file of files) {
        const owner = ownerByFile.get(file);
        if (!owner) throw new PreconditionError(`${file} is not in any resolved runner's configured test universe`, 'defender-outside-universe');
        if (!groups.has(owner)) groups.set(owner, []);
        groups.get(owner).push(file);
      }
      if (groups.get(runner).length === 0 && groups.size > 1) groups.delete(runner);
      return groups;
    };
    // `targets` are the fault's files, passed so a runner that can tell which
    // file the interpreter actually loaded (Python) reports it back.
    const runDefenders = async (files, targets = [], treeDir = iso.projectDir) => {
      if (commandTemplate) {
        const granted = commandBudget?.runBudget(budgetMs) ?? budgetMs;
        const result = await timedRun(runner, { projectDir: treeDir, sourceDir: projectDir, python, files, budgetMs: granted, commandTemplate, serial, workers, targets });
        commandBudget?.assertOpen();
        commandBudget?.assertNotCut(granted, budgetMs, result.timeouts);
        return result;
      }
      const groups = partitionConfigured(files);
      const parts = [];
      for (const [r, group] of groups) {
        commandBudget?.assertOpen();
        if (r !== runner) await ensureOwned(r, group[0]);
        const granted = commandBudget?.runBudget(budgetMs) ?? budgetMs;
        const part = await timedRun(r, { projectDir: treeDir, sourceDir: projectDir, python, files: group, budgetMs: granted, serial, workers, targets, projects: manifests.get(r)?.projects });
        parts.push(part);
        commandBudget?.assertOpen();
        commandBudget?.assertNotCut(granted, budgetMs, part.timeouts);
      }
      return mergeRuns(parts);
    };
    /**
     * Everything that differs between scratch trees: where the defenders run,
     * which file the interpreter must have loaded, and how a runner-reported
     * path maps back to the repository. One per tree; a fault only ever uses
     * the tree it was handed.
     */
    const treeContext = (scratch) => {
      const real = scratch === iso ? isoReal : realpathSync(scratch.projectDir);
      return {
        iso: scratch,
        isoReal: real,
        runDefenders: (files, targets = []) => runDefenders(files, targets, scratch.projectDir),
        // The runner that will LOAD the subject, which is not always the project
        // runner — a `.py` source file is Python's whatever the project runs.
        fatalEditFor: (file) => runnerFor(scratch.projectDir, file, runner).fatalEdit?.(),
        // A path from the runner is absolute inside the SCRATCH worktree, or
        // project-relative. Either way history is read from the real repository,
        // so both must land on a repo-root-relative path. The runner reports
        // realpaths (/private/var on macOS) while the worktree path may not be
        // one — realpath both sides or every comparison silently misses.
        toRepoPath: (p) => relative(root, join(projectDir, isAbsolute(p) ? relative(real, realpathSync(p)) : p)),
      };
    };
    const primary = treeContext(iso);
    // Under a fan-out every baseline is measured before any fault is applied,
    // then frozen: planning that found one missing would be a bug in the
    // replay below, and a fault worker must never run a baseline itself.
    let baselinesFrozen = false;
    /**
     * The defenders' runs on unmodified source, shared by every fault with the
     * same defender set and topped up on demand: reuse asks for one run, a
     * full probe for N, and the first run is the same run. The rules are the
     * ones a single loop used to apply: stop at the first non-green run, and
     * when that run FAILED, finish the remaining runs so a flaky defender can
     * be told from a broken one. A prefix that already stopped is never
     * extended with more normal runs.
     */
    const ensureBaseline = async (defenders, want, stage, { reuse = false, tree = primary } = {}) => {
      const key = defenders.join('\n');
      if (!baselineCache.has(key)) baselineCache.set(key, { runs: [], loadMessage: undefined, flakeFinished: false });
      const entry = baselineCache.get(key);
      // Measured ahead under a fan-out and it threw: every fault that asks
      // gets the same error, as it would have met it asking serially.
      if (entry.error) throw entry.error;
      const stopped = () => entry.runs.length > 0 && entry.runs[entry.runs.length - 1].outcome !== 'pass';
      const needed = (entry.runs.length < want && !stopped())
        || (want === confirmRuns && !entry.flakeFinished && entry.runs.length < confirmRuns && entry.runs[entry.runs.length - 1].outcome === 'fail');
      if (baselinesFrozen && needed) throw new Error('internal: a baseline was requested after the fan-out started');
      while (entry.runs.length < want && !stopped()) {
        stage(reuse ? 'reuse-baseline' : 'baseline', entry.runs.length + 1, want);
        const res = await tree.runDefenders(defenders);
        if (reuse) measurements.reuseBaselineRuns++;
        entry.runs.push(res.run);
        if (res.run.outcome !== 'pass') entry.loadMessage = res.loadMessage;
      }
      if (want === confirmRuns && !entry.flakeFinished && entry.runs.length < confirmRuns && entry.runs[entry.runs.length - 1].outcome === 'fail') {
        for (let i = entry.runs.length; i < confirmRuns; i++) {
          stage('baseline-flake', i + 1, confirmRuns);
          entry.runs.push((await tree.runDefenders(defenders)).run);
        }
        entry.flakeFinished = true;
      }
      return entry;
    };
    /** Which runner each defender runs under, when more than the project runner is involved. */
    const byRunner = (files) => {
      const groups = partitionConfigured(files);
      if (groups.size <= 1) return undefined; // one runner ran them all, whichever it was
      return Object.fromEntries([...groups].map(([r, group]) => [labelOf(r), group]));
    };

    const faults = scopedClaims.flatMap((claim) => claim.faults.map((fault, i) => ({ claim, fault, firstOfClaim: i === 0 })));
    // Records reach the caller in claim/fault order whatever order the trees
    // finish in, so `onProgress` and the evidence are deterministic.
    const emitter = orderedEmitter(faults.length, (record) => {
      records.push(record);
      onProgress(record);
    });
    // Every finished record is also kept by index: when the command budget
    // runs out, a record that finished but is still held back behind an
    // unfinished predecessor is a full measurement and survives.
    const settle = (index, record) => {
      ctx.settled.set(index, record);
      emitter.settle(index, record);
    };
    /**
     * A fault that threw. A precondition failure is a statement about the
     * whole run — the interpreter is loading a different copy of the source,
     * the runner is not resolvable — and continuing would produce verdicts
     * that are all false. Everything else is this one fault's problem.
     */
    const failed = (common, err, tree, discoveryHashes) => {
      if (err instanceof PreconditionError) throw err;
      const error = err;
      const record = errorRecord({ ...common, error, inputs: safeInputs(tree.iso.projectDir, common.fault, common.defenders, { testUniverseHash, discoveryHashes }) });
      onWarn(`${common.claim.id}/${common.fault.id}: ${record.detail.message} — reported as unverifiable so the rest of the run still produces evidence.`);
      return record;
    };
    /**
     * Everything about a fault that is decided on unmodified source, in the
     * first tree: its defenders, every input hash, the anchor, verdict reuse
     * and the shared baseline. Returns a finished record, or the state the
     * measurement needs. A fault that never mutates (no defenders, a bad
     * anchor, a baseline that is not green N/N) finishes here.
     */
    const prePlanOne = async ({ claim, fault }) => {
      const { requested } = defenderSelection(claim, fault);
      const declared = requested.length ? resolveDefenders(iso.projectDir, requested) : null;
      if (declared && !commandTemplate) {
        const excluded = declared.filter((file) => !ownerByFile.has(file));
        for (const file of excluded) {
          const expectedOwner = owned.find((candidate) => candidate.owns?.(iso.projectDir, file));
          const check = expectedOwner && ownedChecked.get(expectedOwner);
          if (expectedOwner && check && !check.ok) {
            throw new PreconditionError(`${file} is a ${expectedOwner.name} test (${expectedOwner.name === 'python' ? 'it is a .py file' : `it lives under ${expectedOwner.name}'s testDir`}) but ${expectedOwner.name} is not resolvable for the ${mode === 'worktree' ? 'scratch worktree' : 'project'} (${check.message}).`, 'defender-misrouted');
          }
        }
        if (excluded.length) throw new PreconditionError(`${claim.id}/${fault.id}: defendedBy resolves to ${excluded.join(', ')}, but the configured runners do not collect ${excluded.length === 1 ? 'that file' : 'those files'}`, 'defender-excluded');
      }
      // Mock-awareness: a discovered file that mocks the target is not a
      // defender; a declared one that mocks it stays (the author named it)
      // but is listed, because a declared defender that mocks the subject
      // is a broken evidence chain the author should see.
      const mockInfo = declared ? classifyDefenders(iso.projectDir, fault.file, declared) : discoverDefendersDetailed(iso.projectDir, fault.file, allTests);
      const defenders = declared ?? mockInfo.canDetect;
      const discoveryHashes = declared ? {} : hashDiscoveryDependencies(iso.projectDir, mockInfo.dependencies, iso.mode === 'worktree' ? discoveryHashCache : new Map());
      const stage = (name, i, n) => onStage({ claimId: claim.id, faultId: fault.id, stage: name, i, n });
      const common = { claim, fault, defenders, discovered: declared === null, byRunner: byRunner(defenders), mocking: mockInfo.mocking, signals: mockInfo.signals };
      try {
        if (!declared && mockInfo.indeterminate.length > 0) {
          return { record: discoveryIndeterminateRecord({ ...common, inputs: safeInputs(iso.projectDir, fault, defenders, { testUniverseHash, discoveryHashes }), indeterminate: mockInfo.indeterminate }) };
        }
        const args = { ...common, typechecker, typecheckBudget: () => commandBudget?.runBudget(budgetMs) ?? budgetMs, typecheckCut: (granted, outcome) => commandBudget?.assertNotCut(granted, budgetMs, outcome.status === 'timeout' ? 1 : 0), allTests, iso, onWarn, confirmRuns, escalate, controlCache, stage, prior: prior.get(`${claim.id}/${fault.id}`)?.record, priorRunId: prior.get(`${claim.id}/${fault.id}`)?.runId, testUniverseHash, discoveryHashes, ensureBaseline, dependencyHasher,
          historyRef: snapshot ?? (mode === 'worktree' ? head : 'HEAD'), historyDir: root };
        return { args, pre: await prePlanFault(args), common, discoveryHashes };
      } catch (err) {
        return { record: failed(common, err, primary, discoveryHashes) };
      }
    };
    const finishPlanOne = async ({ args, pre, common, discoveryHashes }) => {
      try {
        const planned = await planFault(args, pre);
        if (planned.record) return planned;
        return { state: { ...planned.state, common } };
      } catch (err) {
        return { record: failed(common, err, primary, discoveryHashes) };
      }
    };
    const planOne = async (item) => {
      const pre = await prePlanOne(item);
      return pre.record ? pre : finishPlanOne(pre);
    };
    /**
     * Every defender set's baseline asks, replayed in the order a serial run
     * makes them (one live run to license reuse, then N unless reuse held),
     * so the runs and their counts are the serial ones. Sets are independent:
     * they run side by side, one set per tree; a set's asks stay in order.
     */
    const measureBaselineSet = async ({ defenders, asks }, tree) => {
      for (const ask of asks) {
        let reused = false;
        if (ask.reuseAsk) {
          const live = await ensureBaseline(defenders, 1, ask.stage, { reuse: true, tree });
          reused = live.runs.every((run) => run.outcome === 'pass');
        }
        if (!reused && ask.fullAsk) await ensureBaseline(defenders, confirmRuns, ask.stage, { tree });
      }
    };
    const baselineAsks = (prePlanned) => {
      const sets = new Map();
      for (const p of prePlanned) {
        if (p.record || !(p.pre.reuseAsk || p.pre.fullAsk)) continue;
        const key = p.args.defenders.join('\n');
        if (!sets.has(key)) sets.set(key, { defenders: p.args.defenders, asks: [] });
        sets.get(key).asks.push({ reuseAsk: p.pre.reuseAsk, fullAsk: p.pre.fullAsk, stage: p.args.stage });
      }
      return [...sets.values()];
    };
    // A precondition failure is about the whole run; anything else a baseline
    // throws belongs to the faults that ask for that baseline.
    const fatalToTheRun = (err) => err instanceof PreconditionError;
    const freshTree = () => {
      const scratch = createScratch({ repoRoot: root, projectDir, ref: snapshot ?? ref, scratchBase, nodeModules });
      extraTrees.push(scratch);
      return treeContext(scratch);
    };
    const releaseTrees = () => { while (extraTrees.length) extraTrees.pop().cleanup(); };
    const releaseTree = (tree) => { extraTrees.splice(extraTrees.indexOf(tree.iso), 1); tree.iso.cleanup(); };
    /** Apply, probe, control, escalate and restore one fault in `tree`. */
    const measureOne = async (state, tree, opts) => {
      try {
        return await measureFault(state, tree, opts);
      } catch (err) {
        return failed(state.common, err, tree, state.discoveryHashes);
      }
    };

    if (faultWorkers === 1) {
      // Exactly the serial loop: plan and measure each fault before the next.
      for (const [index, item] of faults.entries()) {
        if (item.firstOfClaim) commandBudget?.assertOpen();
        commandBudget?.assertOpen();
        const planned = await planOne(item);
        settle(index, planned.record ?? await measureOne(planned.state, primary));
      }
    } else {
      // Defender sets that have shown they share something with the other
      // trees (#270): every fault of theirs is measured with nothing else in
      // flight, and every record says so.
      const unsafe = new Set();
      const setKey = (state) => state.defenders.join('\n');
      const markUnsafe = (key, why) => {
        if (unsafe.has(key)) return;
        unsafe.add(key);
        onWarn(`defender set ${key.split('\n').join(', ')} is not parallel-safe: ${why}, so its tests share something across scratch trees (a fixed port, a database, a temp path). Its faults are measured with nothing else in flight. Make those tests hermetic (an ephemeral port, a per-run directory) to get the fan-out back for them.`);
      };
      const tagUnsafe = (state, record) => {
        if (unsafe.has(setKey(state)) && !record.reusedFrom && record.detail) record.detail.notParallelSafe = true;
        return record;
      };
      Object.assign(measurements, { aloneConfirmRuns: 0, aloneConfirmMs: 0, remeasuredFaults: 0, remeasureMs: 0 });
      // 1. Everything before a baseline, for every fault, in order, on the
      //    clean first tree: input hashes, anchors and type checks are read
      //    before any fault is applied anywhere and before any baseline runs.
      // A fault that asks for no baseline (discovery indeterminate, a bad
      // anchor, a refused type check, reused outright, a planning error) is
      // finished and published now: a command budget that runs out during
      // the baselines must take along only the faults that depend on them.
      const prePlanned = [];
      for (const [index, item] of faults.entries()) {
        if (item.firstOfClaim) commandBudget?.assertOpen();
        commandBudget?.assertOpen();
        let p = await prePlanOne(item);
        if (!p.record && !p.pre.reuseAsk && !p.pre.fullAsk) {
          const planned = await finishPlanOne(p);
          p = { record: planned.record ?? await measureOne(planned.state, primary) };
        }
        prePlanned.push(p);
        if (p.record) settle(index, p.record);
      }
      // 2. Baselines: independent defender sets side by side, one per tree,
      //    each set's asks in serial order. A set that came out anything but
      //    green while another set was running is measured again, alone, in a
      //    fresh tree, before it is believed: a loaded machine fails suites.
      const sets = baselineAsks(prePlanned);
      const baselineSlots = [primary];
      for (let i = 1; i < Math.min(faultWorkers, sets.length); i++) {
        commandBudget?.assertOpen();
        baselineSlots.push(freshTree());
      }
      const baselineContended = baselineSlots.length > 1;
      await runPool(sets, baselineSlots, async (set, tree) => {
        try {
          await measureBaselineSet(set, tree);
        } catch (err) {
          if (fatalToTheRun(err)) throw err;
          baselineCache.get(set.defenders.join('\n')).error = err;
        }
      }, { beforeEach: () => commandBudget?.assertOpen() });
      releaseTrees();
      if (baselineContended) {
        for (const set of sets) {
          const key = set.defenders.join('\n');
          const entry = baselineCache.get(key);
          if (!entry || entry.error || entry.runs.every((run) => run.outcome === 'pass')) continue;
          commandBudget?.assertOpen();
          baselineCache.delete(key);
          const fresh = freshTree();
          try {
            await measureBaselineSet(set, fresh);
          } catch (err) {
            if (fatalToTheRun(err)) throw err;
            baselineCache.get(key).error = err;
          } finally {
            releaseTrees();
          }
          baselineCache.get(key).remeasuredSerially = true;
          // Red beside other sets, green alone: the red was theirs, so this
          // set shares something with the other trees. Its faults are probed
          // with nothing else in flight (#270).
          if (baselineCache.get(key).runs.every((run) => run.outcome === 'pass')) markUnsafe(key, 'its baseline failed beside other defender sets and passed alone');
        }
      }
      baselinesFrozen = true;
      // 3. The rest of planning, in order, against the measured baselines.
      const pending = [];
      const serialLane = []; // faults of a set already known not to be parallel-safe
      for (const [index, p] of prePlanned.entries()) {
        if (p.record) continue;
        const planned = await finishPlanOne(p);
        if (planned.record) settle(index, planned.record);
        else if (!planned.state.mutate) settle(index, await measureOne(planned.state, primary));
        else if (unsafe.has(setKey(planned.state))) serialLane.push({ index, state: planned.state });
        else pending.push({ index, state: planned.state });
      }
      // 4. Faults: one tree per fault in flight, never more trees than faults.
      //    Every run records whether it was alone; a fault whose runs were all
      //    kills beside other faults stops before its last run (#270).
      const slots = [primary];
      for (let i = 1; i < Math.min(faultWorkers, pending.length); i++) {
        commandBudget?.assertOpen();
        slots.push(freshTree());
      }
      const overlap = createOverlapTracker();
      const outcomes = [];
      await runPool(pending, slots, async ({ index, state }, tree) => {
        const token = overlap.enter();
        let result;
        try {
          result = await measureOne(state, tree, { overlap });
        } finally {
          overlap.leave(token);
        }
        outcomes.push({ index, state, result, contended: token.contended });
      }, { beforeEach: () => commandBudget?.assertOpen() });
      // The fan-out is over: its trees go now, so no more than n ever exist.
      releaseTrees();
      outcomes.sort((a, b) => a.index - b.index);
      // Nothing is settled before it is believed: a deferred kill, a
      // disagreement and a contended outcome a loaded machine can manufacture
      // stay unpublished — and a command budget that runs out now reports
      // them not reached, never as what the contended runs said.
      const finals = [];
      const remeasure = [];
      const confirm = [];
      for (const o of outcomes) {
        if (o.result.deferred) confirm.push(o);
        else if (o.result.disagreed) { markUnsafe(setKey(o.state), 'its runs beside other faults failed where a run alone passed'); remeasure.push(o); }
        else if (o.contended && needsSerialRemeasure(o.result)) remeasure.push(o);
        else finals.push({ index: o.index, state: o.state, record: o.result });
      }
      // 5. Each deferred kill takes its last run alone, in order, in one tree
      //    of its own that nothing else touches while it runs.
      if (confirm.length) {
        const solo = freshTree();
        try {
          for (const o of confirm) {
            if (unsafe.has(setKey(o.state))) { remeasure.push(o); continue; }
            commandBudget?.assertOpen();
            const started = performance.now();
            const result = await measureOne(o.state, solo, { priorRuns: o.result.runs, allAlone: true });
            measurements.aloneConfirmRuns++;
            measurements.aloneConfirmMs += performance.now() - started;
            if (result.disagreed) { markUnsafe(setKey(o.state), 'its runs beside other faults failed where a run alone passed'); remeasure.push(o); }
            else if (result.verdict === 'killed') finals.push({ index: o.index, state: o.state, record: result });
            else remeasure.push(o); // anything but the kill the contended runs suggested: measured again, alone, in full
          }
        } finally {
          releaseTrees();
        }
      }
      // A kill in a set that is not parallel-safe rests on runs a neighbour may
      // have caused; unless every one of them was alone, it is measured again.
      for (const f of finals.splice(0)) {
        const runs = f.record.detail?.probeRuns ?? [];
        if (f.record.verdict === 'killed' && unsafe.has(setKey(f.state)) && !runs.every((run) => run.alone)) remeasure.push(f);
        else finals.push(f);
      }
      for (const f of finals) settle(f.index, tagUnsafe(f.state, f.record));
      // 6. Measured alone, in claim/fault order. A re-measure gets a fresh tree
      //    each: the contended run may have left state behind in its tree (a
      //    counter, a cache, a half-written file from a killed process), and
      //    the serial answer must not inherit it. A set known unsafe before the
      //    fan-out is probed in one tree, as a serial run would.
      const alone = [...remeasure.map((o) => ({ ...o, again: true })), ...serialLane].sort((a, b) => a.index - b.index);
      let laneTree;
      try {
        for (const o of alone) {
          commandBudget?.assertOpen();
          const started = performance.now();
          const tree = o.again ? freshTree() : (laneTree ??= freshTree());
          let record;
          try {
            record = await measureOne(o.state, tree, { allAlone: true });
          } finally {
            if (o.again && tree !== primary) releaseTree(tree);
          }
          if (o.again) {
            record.detail.remeasuredSerially = true;
            measurements.remeasuredFaults++;
            measurements.remeasureMs += performance.now() - started;
          }
          settle(o.index, tagUnsafe(o.state, record));
        }
      } finally {
        releaseTrees();
      }
    }
  } finally {
    // Every tree, even when a worker failed: the pool has already let every
    // in-flight fault restore before rethrowing.
    for (const scratch of extraTrees.reverse()) scratch.cleanup();
    typechecker?.cleanup();
    iso.cleanup();
  }

  commandBudget?.assertOpen();

  assertNotCancelled();
  const dirty = isDirty(root);
  measurements.runnerMs = runnerClock.totalMs;
  measurements.elapsedMs = performance.now() - measuredStart;
  measurements.overheadMs = measurements.elapsedMs - measurements.runnerMs;
  return {
    schemaVersion: 1,
    tool: { name: 'testguard', version: toolVersion },
    run: {
      id: `run-${startedAt.replace(/[-:.]/g, '').slice(0, 15)}`,
      startedAt,
      finishedAt: new Date().toISOString(),
      repo: { head, dirty, ...(snapshot ? { snapshot } : {}), ...(ignoredDirty.length ? { ignoredDirty } : {}) },
      // Where the runner came from is part of what was measured: recorded for
      // every resolved runner, as the schema documents, not only the builtin.
      runner: recordedRunner,
      instrument,
      ...(typechecker ? { typecheck: typechecker.spec } : {}),
      reuse: reuseSummary(records),
      ...(runnersUsed.size > 1 ? { runners: [...runnersUsed].map(([n, v]) => ({ name: n, ...(v ? { version: v } : {}) })) } : {}),
      confirmRuns,
      measurements,
      ...(!runnerCommand ? { workers: serial ? 1 : workers } : {}),
      ...(serial && !runnerCommand ? { serial: true } : {}),
      // Recorded only for a fan-out, so a serial run's evidence is unchanged.
      ...(faultWorkers > 1 ? { faultWorkers } : {}),
      ...fanOutPolicy({ faultWorkersSource, cpus }),
      ...(contention.detected ? { contention } : {}),
      ...(confirmRuns < 3 ? { provisional: true } : {}),
      // The isolation that was actually created, not the mode that was asked
      // for. A record saying `worktree` while the probe edited the project in
      // place would be a false statement about where the evidence came from,
      // and nothing downstream could detect it.
      mode: iso.mode,
      writeBoundary: boundary,
    },
    records,
    origins: recordedOriginSummary(records),
  };
}

/**
 * The record a fault gets when probing it threw.
 *
 * Before this existed, an unexpected error anywhere inside one fault's probe
 * killed the process: no evidence file at all, every verdict already decided
 * thrown away, and an exit code no caller can read against GATE-SEMANTICS. One
 * bad fault should cost that fault and nothing else.
 *
 * `unverifiable` is the honest verdict — the claim could not be probed — and it
 * gates, so the failure is loud rather than absorbed into a green run. Pure, so
 * every branch is testable without provoking a crash.
 */
export function errorRecord({ claim, fault, defenders, discovered, byRunner, mocking = [], signals = [], error, inputs }) {
  const message = String(error?.message ?? error).split('\n')[0].slice(0, 1024);
  return {
    fingerprint: fingerprint({ claimId: claim.id, subjectId: fault.id, file: fault.file, verdict: 'unverifiable' }),
    claim: { id: claim.id, statement: claim.statement, severity: claim.severity, source: claim.source, producedBy: claim.producedBy },
    subject: subjectOf(fault, sha256),
    verdict: 'unverifiable',
    detail: { baselineRuns: [], probeRuns: [], reason: 'probe-error', message },
    defenders: { ...defenderSelection(claim, fault), resolved: defenders, nocover: defenders.length === 0, ...(discovered ? { discovered: true } : {}), ...(byRunner ? { byRunner } : {}), ...(mocking.length ? { mocking } : {}), ...(signals.length ? { signals } : {}) },
    inputs,
  };
}

/** Automatic discovery failed closed: uncertainty can never become `nocover`. */
export function discoveryIndeterminateRecord({ claim, fault, defenders, discovered, byRunner, mocking = [], signals = [], inputs, indeterminate }) {
  const first = indeterminate[0];
  const message = `${indeterminate.length} candidate test file${indeterminate.length === 1 ? '' : 's'} could not be resolved safely; first: ${first.file} (${first.reason ?? 'unknown'})`.slice(0, 1024);
  return {
    fingerprint: fingerprint({ claimId: claim.id, subjectId: fault.id, file: fault.file, verdict: 'unverifiable' }),
    claim: { id: claim.id, statement: claim.statement, severity: claim.severity, source: claim.source, producedBy: claim.producedBy },
    subject: subjectOf(fault, sha256),
    verdict: 'unverifiable',
    detail: { baselineRuns: [], probeRuns: [], reason: 'defender-discovery-indeterminate', message },
    defenders: { ...defenderSelection(claim, fault), resolved: defenders, nocover: false, ...(discovered ? { discovered: true } : {}), ...(byRunner ? { byRunner } : {}), ...(mocking.length ? { mocking } : {}), ...(signals.length ? { signals } : {}) },
    inputs,
  };
}

/**
 * `inputs` for a record built after something threw — which is exactly when a
 * file may no longer be readable. Hashing must not be the second failure, so an
 * unreadable file hashes as empty: never equal to a real file's hash, so the
 * record can only ever fail a reuse check, never pass one by accident.
 */
function safeInputs(projectDir, fault, defenders, extra = {}) {
  const h = (f) => {
    try {
      return hashFile(join(projectDir, f));
    } catch {
      return sha256('');
    }
  };
  return { targetHash: h(fault.file), defenderHashes: Object.fromEntries(defenders.map((f) => [f, h(f)])), ...extra };
}

function hashDiscoveryDependencies(projectDir, dependencies = [], cache = new Map()) {
  return Object.fromEntries(dependencies.map((file) => {
    if (!cache.has(file)) cache.set(file, hashFile(join(projectDir, file)));
    return [file, cache.get(file)];
  }));
}

/**
 * The negative control the green baseline cannot provide.
 *
 * A green baseline proves the defenders can PASS on unmodified source, which
 * makes "the harness is broken, so everything looks killed" structurally
 * impossible. It says nothing about the opposite direction: if the fault is
 * applied to code the test process never executes, the baseline is green,
 * every probe run is green, and every claim is reported SURVIVED. The output
 * reads as a devastating audit finding and is entirely false, and nothing in
 * the run contradicts it, because every individual check passed.
 *
 * So ask the question directly: replace the subject with something its loader
 * cannot parse, and see whether the defenders go red. If they stay green they
 * are not executing that file, and every verdict about it is meaningless.
 *
 * The predicate is "the run did not stay green", not "a test failed" — an
 * unparseable module usually fails to LOAD, so the runner reports zero tests
 * rather than a failure. Measured, not assumed.
 *
 * One run, not N: the defenders were already green N/N on this exact set, and
 * neither answer here is the optimistic one — `survived` and `unverifiable`
 * both gate.
 */
async function negativeControl({ file, defenders, iso, runDefenders, fatalEditFor, cache, stage }) {
  return singleFlight(cache, `${file}\n${defenders.join('\n')}`, async () => {
    const content = fatalEditFor(file);
    // A runner that cannot say what "this cannot compile" looks like for its
    // language does not get to guess. No control, no signal, verdict unchanged.
    if (content == null) return undefined;
    const control = applyContent(iso.projectDir, file, content, { inPlace: iso.mode === 'in-place' });
    let run;
    try {
      stage('negative-control', 1, 1);
      ({ run } = await runDefenders(defenders, [file]));
    } finally {
      control.restore();
    }
    const reached = run.outcome !== 'pass';
    return reached;
  });
}

/** The type check refused the replacement (or could not finish): no test runs. */
const refusedByTypecheck = (typecheck) => typecheck?.status === 'diagnostics' || typecheck?.status === 'timeout';

/**
 * Apply the fault, type check, restore: before any test run. Not applicable
 * (a file the checker does not judge) is recorded, never skipped silently, and
 * never an obstacle. A checker that itself failed throws, which the caller
 * reports as unverifiable rather than as a verdict about the fault.
 */
async function typecheckFault({ typechecker, iso, fault, budgetMs, stage, detail, cut }) {
  if (!typechecker.applicable(fault.file)) return { status: 'not-applicable' };
  const mutation = applyFault(iso.projectDir, fault, { inPlace: iso.mode === 'in-place' });
  try {
    stage('typecheck', 1, 1);
    // A check the command budget itself cut short is the deadline, not a timeout.
    const outcome = await typechecker.check({ budgetMs });
    cut?.(budgetMs, outcome);
    return outcome;
  } finally {
    mutation.restore();
    if (mutation.restoreSkipped) detail.restoreSkipped = mutation.restoreSkipped;
  }
}

/**
 * Everything about a fault decided before its first baseline run, and no test
 * runner: input hashes, reuse eligibility, the anchor and the type check. None
 * of it depends on a baseline, so a fan-out can do it for every fault first and
 * then measure the baselines of independent defender sets side by side. The
 * type check runs exactly where a serial run would reach it: for a reusable
 * fault in the reuse check, otherwise just before its baseline, under the same
 * condition. Returns what `planFault` needs, and which baseline asks the fault
 * will make (`reuseAsk`: one live run; `fullAsk`: N runs unless reuse holds).
 */
async function prePlanFault(args) {
  const { typechecker, typecheckBudget, typecheckCut, claim, fault, defenders, iso, dependencyHasher, stage, prior, testUniverseHash, discoveryHashes = {} } = args;
  const targetPath = join(iso.projectDir, fault.file);
  const targetExists = existsSync(targetPath);
  const inputs = {
    targetHash: targetExists ? hashFile(targetPath) : sha256(''),
    defenderHashes: Object.fromEntries(defenders.map((f) => [f, hashFile(join(iso.projectDir, f))])),
    testUniverseHash,
    discoveryHashes,
    // Everything the target and the defenders import, and the lockfiles and
    // runner configuration around them: a broken helper changes the answer
    // as surely as a broken target does.
    ...dependencyHasher.inputsFor([fault.file, ...defenders]),
  };

  const subject = subjectOf(fault, sha256);
  const anchor = defenders.length > 0
    ? (targetExists ? locate(readFileSync(targetPath, 'utf8'), fault) : { status: 'file-missing', hits: 0, expected: fault.expectHits ?? 1 })
    : null;

  // Whether a replacement type-checks is a property of the WHOLE program, which
  // no per-fault hash sees: a file added elsewhere can make yesterday's clean
  // fault invalid. So under --typecheck the fault is checked again before any
  // record is carried forward (one warm check, no test run), and reuse needs the
  // same answer. The answer is kept for the measurement if reuse fails, and it
  // comes first there too: a replacement the project's own compiler refuses is
  // a bad fault whatever the defenders do.
  let typecheck; // the type check's outcome for this fault, when one was asked for
  const detail = { baselineRuns: [], probeRuns: [] };
  const reusable = isReusable(prior, { claim, inputs, ...defenderSelection(claim, fault), resolved: defenders, contentHash: subject.contentHash });
  if (typechecker && anchor?.status === 'ok') {
    typecheck = await typecheckFault({ typechecker, iso, fault, budgetMs: typecheckBudget(), stage, detail, cut: typecheckCut });
  }
  const typecheckAgrees = !typechecker || typecheck === undefined || typecheck.status === prior?.detail?.typecheck;
  // A fault the type check refused ran no test, so there is no test run to confirm.
  const reusedOutright = reusable && typecheckAgrees && (defenders.length === 0 || typecheck?.status === 'diagnostics');
  const reuseAsk = reusable && typecheckAgrees && !reusedOutright;
  const fullAsk = !reusedOutright && anchor?.status === 'ok' && !refusedByTypecheck(typecheck);
  return { targetExists, inputs, subject, anchor, typecheck, typecheckAgrees, reusable, detail, reusedOutright, reuseAsk, fullAsk };
}

/**
 * The rest of planning: verdict reuse and the shared baseline. Returns
 * `{ record }` for a reused verdict, otherwise `{ state }` for
 * `measureFault`. `state.mutate` says whether the fault will be applied.
 */
async function planFault(args, pre) {
  const { typechecker, claim, fault, defenders, confirmRuns, ensureBaseline, stage, prior, priorRunId } = args;
  const { targetExists, inputs, subject, typecheck, detail } = pre;

  // Same source, same imports, same defenders, same N, same fault — and the
  // defenders still green right now. The hashes cannot see the environment
  // (installed packages, the interpreter, a data file a test reads), so one
  // live unmodified run of the defender set licenses the carry-forward. It is
  // the first run of the shared baseline, so a fault that is probed after all
  // pays nothing twice. Not green: the fault is probed in full.
  if (pre.reusedOutright || pre.reuseAsk) {
    const live = pre.reuseAsk ? await ensureBaseline(defenders, 1, stage, { reuse: true }) : null;
    if (!live || live.runs.every((run) => run.outcome === 'pass')) {
      return { record: { ...prior, defenders: { ...prior.defenders, ...defenderSelection(claim, fault) }, reusedFrom: prior.reusedFrom ?? priorRunId } };
    }
  }

  let anchor = pre.anchor;

  if (defenders.length > 0) {
    if (anchor.status === 'ok' && typechecker) {
      detail.typecheck = typecheck.status;
      if (typecheck.message) detail.message = typecheck.message;
    }
    if (pre.fullAsk) {
      // The decision stops at the first non-green run — nothing about this
      // fault can be trusted after it. But "failed once in three" and "fails
      // every time" are different problems for whoever has to fix the
      // defender, and the only way to tell them apart is to finish the runs.
      // Paid once per defender set, and only when it is already broken.
      const baseline = await ensureBaseline(defenders, confirmRuns, stage);
      detail.baselineRuns = [...baseline.runs];
      if (baseline.remeasuredSerially) detail.baselineRemeasuredSerially = true;
      // Observed instability of the defenders on UNMODIFIED source: `fail` is
      // the tests running and disagreeing with themselves. A load error or a
      // timeout is not flakiness — nothing was measured about stability — so
      // neither is counted, on either side of the ratio.
      const rate = flakeRate(baseline.runs);
      if (rate) detail.flakeRate = rate;
      if (baseline.runs.some((r) => r.outcome === 'error')) {
        // The defenders did not load. That is not flakiness and not a verdict
        // about the fault; the claim cannot be probed until they do.
        anchor = { status: 'defenders-failed-to-load', hits: anchor.hits, expected: anchor.expected, message: baseline.loadMessage };
      }
    }
  }
  // A refused type check never ran a baseline, so the length check already
  // keeps it from mutating; stated anyway, because that is the rule.
  const mutate = anchor?.status === 'ok' && !refusedByTypecheck(typecheck) && detail.baselineRuns.every((r) => r.outcome === 'pass') && detail.baselineRuns.length === confirmRuns;
  return { state: { ...args, targetExists, inputs, subject, detail, anchor, mutate, typecheck } };
}

/**
 * Apply the fault in `tree`, run the defenders N times, ask the negative
 * control and the wider suite when the fault survives, restore, classify.
 * Reads nothing it did not get from `planFault` except what it measures, so
 * it can run in any scratch tree, and again for a serial re-measure.
 */
async function measureFault(state, tree, { priorRuns = [], overlap, allAlone = false } = {}) {
  const { claim, fault, defenders, allTests, onWarn = () => {}, confirmRuns, escalate, controlCache, stage } = state;
  const detail = { ...state.detail, baselineRuns: [...state.detail.baselineRuns], probeRuns: [] };
  const rawProbeRuns = [...priorRuns]; // spec testRun + the runner's timeout count, which classify needs
  let subjectReached; // the negative control's answer; undefined until it is worth asking
  // Under a fan-out (#270) every run says whether it was measured alone, and
  // a kill may not rest only on runs beside other faults.
  const fanOut = Boolean(overlap) || allAlone;

  if (state.mutate) {
    const { iso, isoReal, runDefenders, fatalEditFor } = tree;
    const mutation = applyFault(iso.projectDir, fault, { inPlace: iso.mode === 'in-place' });
    try {
      const probeRuns = rawProbeRuns;
      for (let i = priorRuns.length; i < confirmRuns; i++) {
        // Every run so far was a kill and none was alone: the last one is
        // taken later, with nothing else in flight, in a tree of its own.
        if (overlap && deferLastRun(probeRuns, confirmRuns, overlap.active > 1)) return { deferred: true, runs: probeRuns };
        const alone = overlap?.runStarted();
        stage('probe', i + 1, confirmRuns);
        const { run, timeouts, loadMessage, failedTests, provenance } = await runDefenders(defenders, [fault.file]);
        probeRuns.push({ ...run, ...(allAlone || alone?.() ? { alone: true } : {}), timeouts, loadMessage, failedTests });
        // Only when the suite actually loaded. A run that failed to load
        // explains an absent import by itself — saying the defenders never
        // reached the file would be true and useless, and it would put the
        // signal on every fault whose replacement does not parse. Checked in
        // every tree the fault is measured in.
        if (i === priorRuns.length && run.outcome !== 'error') checkProvenance({ claim, fault, provenance, isoReal, detail, onWarn });
        // Red beside other faults, green alone: the red was theirs. Never a
        // verdict about this fault, and never `inconsistent-probe`.
        if (fanOut && aloneDisagrees(probeRuns)) return { disagreed: true, runs: probeRuns };
        if (shouldStopEarly(probeRuns)) break;
      }
      // Another fault started during the last run after all: that run is set
      // aside, and the kill waits for one taken alone.
      if (overlap && mustConfirmAlone(probeRuns, confirmRuns)) return { deferred: true, runs: probeRuns.slice(0, -1) };
      detail.probeRuns = probeRuns.map(({ timeouts, loadMessage, failedTests, ...run }) => run);
      const provisional = classify({ defenders, anchor: state.anchor, baselineRuns: detail.baselineRuns, probeRuns, confirmRuns });
      // `provisional` is deliberately computed BEFORE the control: the control is what turns a survivor into an unverifiable, so asking it first would be circular.

      // Charge the negative control only where a false answer is expensive:
      // on a survivor. A kill already proves the defenders reached the code,
      // and paying for it on every fault would be waste.
      if (provisional.verdict === 'survived') {
        subjectReached = await negativeControl({ file: fault.file, defenders, iso, runDefenders, fatalEditFor, cache: controlCache, stage });
        if (subjectReached !== undefined) detail.negativeControl = subjectReached ? 'reached' : 'not-reached';
        if (subjectReached === false) {
          onWarn(`${claim.id}/${fault.id}: the defenders stayed green with ${fault.file} replaced by something that cannot compile, so they never execute it. Every verdict about this file would be about their reach, not their assertions — reported as unverifiable rather than as a survivor.`);
        }
      }

      // Escalation: does anything *undeclared* catch it? A single run cannot
      // say — a flaky test elsewhere in the suite would take the credit — so
      // a test is an undeclared killer only if it fails in all N runs.
      // Skipped when the subject is not executed at all: nothing the wider
      // suite does could be evidence about a file nobody loads.
      const broader = allTests.filter((t) => !defenders.includes(t));
      if (provisional.verdict === 'survived' && subjectReached !== false && escalate && broader.length > 0) {
        // The rule lives in attribution.mjs as a pure fold; this loop only
        // decides when to stop asking the runner.
        let fold = escalationStart();
        for (let i = 0; i < confirmRuns; i++) {
          stage('escalation', i + 1, confirmRuns);
          fold = foldEscalationRun(fold, await runDefenders(allTests));
          if (fold.stoppedEarly) break;
        }
        Object.assign(detail, escalationResult(fold, confirmRuns));
      }
    } finally {
      mutation.restore();
      // The restore found nothing to put back. In worktree mode that is a
      // disturbed run, not a failed one (see applyFault) — but a reader
      // has to be able to tell, because it means something outside this
      // process was deleting the tree the verdicts came from.
      if (mutation.restoreSkipped) detail.restoreSkipped = mutation.restoreSkipped;
    }
  }
  return finalizeFault(state, tree, { detail, rawProbeRuns, subjectReached });
}

/** The verdict and everything attached to it, once the runs are in. */
function finalizeFault(state, tree, { detail, rawProbeRuns, subjectReached }) {
  const { claim, fault, defenders, discovered, confirmRuns, byRunner, mocking = [], signals = [], historyRef, historyDir, anchor, targetExists, inputs, subject, typecheck } = state;
  const { iso, toRepoPath } = tree;
  const { verdict, reason, killKind } = classify({ defenders, anchor, baselineRuns: detail.baselineRuns, probeRuns: rawProbeRuns, confirmRuns, subjectReached, typecheck });
  if (reason && !detail.reason) detail.reason = reason;
  if (killKind) detail.killKind = killKind;
  const killKindReason = killKindReasonOf(rawProbeRuns, killKind);
  if (killKindReason) detail.killKindReason = killKindReason;
  if (anchor && anchor.status !== 'ok' && anchor.status !== 'file-missing' && anchor.status !== 'defenders-failed-to-load') detail.anchor = { hits: anchor.hits, expected: anchor.expected };

  const blast = targetExists ? blastRadius(iso.projectDir, fault.file) : 0;

  // L3: a kill by a test written in the same change as the code it guards is
  // weaker evidence than one written separately. Signal only — the verdict is
  // already decided above, and ranking is the only consumer.
  if (verdict === 'killed' && historyRef) {
    // Only the tests that actually failed on the fault are its killers.
    const killers = killersFromRuns(rawProbeRuns);
    detail.independence = classifyIndependence({ dir: historyDir, ref: historyRef, targetFile: toRepoPath(fault.file), defenders: (killers.length ? killers : defenders).map(toRepoPath) });
  }

  // Why a survivor on a write path was missed: each defender that mocks the
  // persistence layer, with its assertion mix. Descriptive, never predictive —
  // it is attached to a verdict already reached and selects nothing. The sweep
  // document carried this alone until claimspec v1 admitted it to the evidence.
  const allSignals = [...signals, ...persistenceSignalsFor({ verdict, fault, defenders, projectDir: iso.projectDir })];

  return {
    fingerprint: fingerprint({ claimId: claim.id, subjectId: fault.id, file: fault.file, verdict }),
    claim: { id: claim.id, statement: claim.statement, severity: claim.severity, source: claim.source, producedBy: claim.producedBy },
    subject,
    verdict,
    detail,
    defenders: { ...defenderSelection(claim, fault), resolved: defenders, nocover: defenders.length === 0, ...(discovered ? { discovered: true } : {}), ...(byRunner ? { byRunner } : {}), ...(mocking.length ? { mocking } : {}), ...(allSignals.length ? { signals: allSignals } : {}) },
    inputs,
    rank: rank({ severity: claim.severity, sourceKind: claim.source.kind, blast, independence: detail.independence?.class }),
  };
}

/**
 * The negative control the green baseline cannot provide.
 *
 * A clean baseline proves the harness is not reporting everything as broken —
 * the failure mode where a misread runner flatters nothing. It says nothing
 * about the opposite direction: a fault that the interpreter never executes.
 * Then the baseline is green, every fault SURVIVES, and the report reads as a
 * devastating audit finding while being entirely false.
 *
 * Node cannot reach that state from a scratch worktree, because Node loads
 * files by path. Python can. `sys.path[0]` is the working directory, so an
 * ordinary editable install — a `.pth` file appended to sys.path — loses to
 * the tree being probed and is harmless. What wins is a **meta path finder**:
 * a strict editable install registers one, and it is consulted before every
 * path entry. Then the tests import the original file while TestGuard faults
 * the copy, and the whole run is false in the one direction nothing else
 * catches. Measured, not assumed: with the fault live the reporter is asked
 * which file was actually loaded, and the answer is checked.
 *
 * Loaded from outside the tree being probed is never recoverable and never
 * ambiguous: the whole run is refused. Never loaded at all is recorded and
 * warned about but not refused — an import inside a branch the fault does not
 * reach is legitimate, and refusing would be the tool substituting its
 * judgement for the author's.
 */
export function checkProvenance({ claim, fault, provenance, isoReal, detail, onWarn }) {
  if (!provenance || !(fault.file in provenance)) return;
  const loaded = provenance[fault.file];
  if (loaded === null) {
    detail.targetNotImported = true;
    onWarn(`${claim.id}/${fault.id}: the defenders never imported ${fault.file}, so nothing they do could detect a fault in it. Whatever the runs show is a statement about the defenders' reach, not about their assertions.`);
    return;
  }
  if (isoReal && !isInside(isoReal, loaded)) {
    throw new PreconditionError(
      `${fault.file}: the fault was applied to ${join(isoReal, fault.file)}, but the interpreter imported ${loaded} instead. ` +
      'Python loaded a different copy of this module, so nothing TestGuard changes can ever run and every claim would be reported as SURVIVED however good the tests are. ' +
      'The usual cause is an install that registers an import hook ahead of sys.path — a strict editable install (`pip install -e . --config-settings editable_mode=strict`, and some build backends by default) — or a plain install that left a copy in site-packages. ' +
      'Either reinstall the project against the tree being probed, or run with --in-place so the tree the install points at is the tree that is faulted.',
      'module-shadowed',
    );
  }
}

function sameInputs(prior, inputs, requested, resolved) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return prior.inputs.targetHash === inputs.targetHash
    && same(prior.inputs.defenderHashes, inputs.defenderHashes)
    && same(prior.defenders.requested, requested)
    && same(prior.defenders.resolved, resolved);
}
