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
import { detectContention, contentionWarning } from './contention.mjs';
import { createScratch, inPlace, PreconditionError } from './worktree.mjs';
import { applyContent, applyFault, locate } from './inject.mjs';
import { resolveDefenders, parseCommandTemplate } from './runners/shared.mjs';
import { selectRunner, discoverRunnerManifest, RUNNERS, OWNED_RUNNERS, partitionByRunner, mergeRuns, runnerLabel, runnerFor } from './runners/index.mjs';
import { classify, shouldStopEarly } from './classify.mjs';
import { blastRadius, rank } from './rank.mjs';
import { classifyIndependence } from './independence.mjs';
import { escalationStart, foldEscalationRun, escalationResult, flakeRate, killersFromRuns, subjectOf, isReusable, defenderSelection } from './attribution.mjs';
import { hashFile, sha256 } from '../util/hash.mjs';
import { fingerprint } from '../../spec/lib/fingerprint.mjs';
import { recordedOriginSummary } from '../../spec/lib/origins.mjs';
import { persistenceSignalsFor } from '../supply/persistence.mjs';
import { collectOwnedManifests, hashNativeTestUniverse } from './universe.mjs';


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
  if (only.length === 0) throw new PreconditionError('--claim must name at least one claim id');
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const unknown = only.filter((id) => !byId.has(id));
  if (unknown.length) throw new PreconditionError(`--claim: unknown claim id(s) ${unknown.join(', ')}`);
  return only.map((id) => byId.get(id));
}

/** Reuse cannot stand in for a measurement under a different worker policy. */
export function sameWorkerPolicy(previousRun, { workers = 1, serial = workers === 1, runnerCommand } = {}) {
  if (runnerCommand) return previousRun?.workers === undefined && !previousRun?.serial;
  return previousRun?.workers === (serial ? 1 : workers) && Boolean(previousRun?.serial) === serial;
}

/**
 * Probe every fault of every claim. Returns a spec-conformant evidence
 * document; writing it is the caller's job.
 */
export async function probe({
  projectDir,
  claims,
  confirmRuns = 3,
  mode = 'worktree',
  ref = 'HEAD',
  refExplicit = false,
  ignoreDirty = false,
  workers = 1,
  serial = workers === 1,
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
}) {
  if (!Number.isSafeInteger(workers) || workers < 1) throw new PreconditionError('workers must be a positive safe integer');
  resetInterpreterCache(); // Cache only within this measurement, never across commands.
  const measuredStart = performance.now();
  const startedAt = new Date().toISOString();
  const measurements = { elapsedMs: 0, runnerMs: 0, overheadMs: 0, runnerInvocations: 0 };
  const timedRun = async (runner, opts) => {
    assertNotCancelled();
    const start = performance.now();
    measurements.runnerInvocations++;
    try { return await runner.run(opts); }
    finally { measurements.runnerMs += performance.now() - start; }
  };
  commandBudget?.assertOpen();
  // realpath: git reports the repository root by its real path (/private/var
  // on macOS, not /var); every relative() below must start from the same place.
  projectDir = realpathSync(resolve(projectDir));
  const root = gitRoot(projectDir);
  if (mode === 'in-place' && ref !== 'HEAD') throw new PreconditionError('--ref needs a scratch worktree; drop --in-place');
  const head = headSha(root, ref);
  if (!head) throw new PreconditionError(ref === 'HEAD' ? 'repository has no commits; every verdict is tied to a commit' : `ref ${ref} does not resolve to a commit`);

  const scopedClaims = selectClaims(claims.claims, only);
  const targets = [...new Set(scopedClaims.flatMap((c) => c.faults.map((f) => relative(root, join(projectDir, f.file)))))];
  if (mode === 'in-place' && isDirty(root, targets)) {
    throw new PreconditionError(`uncommitted changes in fault target files (${targets.join(', ')}); commit or stash them, or drop --in-place. Only the files faults are applied to must be clean — test files may be dirty, which is what makes --in-place usable while writing tests.`);
  }
  if (includeDirty && mode !== 'worktree') throw new PreconditionError('--include-dirty applies to worktree mode; drop --in-place');
  if (includeDirty && ref !== 'HEAD') throw new PreconditionError('--include-dirty snapshots the working tree; it cannot be combined with --ref');

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
      if (isDirty(root)) snapshot = snapshotWorkingTree(root);
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
        if (selected.error) throw new PreconditionError(`cannot verify dirty defender/config inputs because test discovery failed (${selected.error})`);
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
            throw new PreconditionError(`cannot verify dirty defender/config inputs because ${candidate.name} discovery failed (${error.message})`);
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
        throw new PreconditionError(`${dirty.length} defender/target file${dirty.length === 1 ? ' has' : 's have'} uncommitted changes (${dirty.join(', ')}); worktree mode probes HEAD (${head.slice(0, 7)}), so those changes would be silently ignored. Commit them, run with --include-dirty to probe the working tree, use --in-place, or --ignore-dirty if you mean HEAD as committed.`);
      }
      if (dirty.length) {
        ignoredDirty = dirty.sort();
        onWarn(`${dirty.length} defender/target file${dirty.length === 1 ? ' has' : 's have'} uncommitted changes (${dirty.join(', ')}); probing ${ref === 'HEAD' ? `HEAD (${head.slice(0, 7)})` : `${ref} (${head.slice(0, 7)})`} as committed — the working-tree versions are NOT what is being probed. Recorded in the evidence as repo.ignoredDirty.`);
      }
    }
  }
  // Contention: name it before the first run, and record it, so a later
  // reader of a TIMEOUT or FLAKY-DEFENDER knows the machine was loaded.
  const contention = detectContention();
  if (contention.detected) onWarn(contentionWarning(contention));

  const iso = mode === 'worktree' ? createScratch({ repoRoot: root, projectDir, ref: snapshot ?? ref, scratchBase, nodeModules }) : inPlace({ repoRoot: root, projectDir });
  const isoReal = realpathSync(iso.projectDir);
  const records = [];
  let runnerVersion;
  let runnerSource;
  let primaryManifest;
  let runner = RUNNERS[runnerName === 'auto' ? 'vitest' : runnerName];
  // A runner with more than one engine (Python: pytest or unittest) is recorded
  // by the engine that actually ran, never by the module's name. TestGuard does
  // not say pytest ran when the stdlib runner did.
  const engines = new Map();
  const labelOf = (r) => runnerLabel(r, engines);
  const runnersUsed = new Map(); // every runner that ran defenders, beyond the project runner
  try {
    const commandTemplate = runnerCommand ? parseCommandTemplate(runnerCommand) : undefined;
    if (!commandTemplate) {
      // An unresolvable runner is a precondition failure, not a flaky defender.
      const sel = await selectRunner({ projectDir: iso.projectDir, sourceDir: projectDir, python, name: runnerName, budgetMs, budgetFor: () => commandBudget?.runBudget(budgetMs) ?? budgetMs });
      commandBudget?.assertOpen();
      if (sel.error) {
        throw new PreconditionError(`test runner is not resolvable in the ${mode === 'worktree' ? 'scratch worktree' : 'project'} (${sel.error}). ` +
          (mode === 'worktree' ? 'If dependencies are missing, pass --node-modules <path>, or run with --in-place. Otherwise fix the discovery error above.' : 'If dependencies are missing, install them first. Otherwise fix the discovery error above.'));
      }
      runner = sel.runner;
      runnerVersion = sel.version;
      runnerSource = sel.source;
      primaryManifest = sel.manifest;
      if (sel.engine) engines.set(sel.runner, sel.engine);
    }
    runnersUsed.set(labelOf(runner), runnerVersion ?? readRunnerVersion(projectDir, runner.name));
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
      } catch (error) { throw new PreconditionError(`test discovery failed: ${error.message}`); }
    }
    const ensureOwned = async (r, file) => {
      if (!ownedChecked.has(r)) {
        ownedChecked.set(r, await r.check({ projectDir: iso.projectDir, sourceDir: projectDir, python, budgetMs: commandBudget?.runBudget(budgetMs) ?? budgetMs, budgetFor: () => commandBudget?.runBudget(budgetMs) ?? budgetMs }));
        commandBudget?.assertOpen();
      }
      const c = ownedChecked.get(r);
      if (!c.ok) throw new PreconditionError(`${file} is a ${r.name} test (${r.name === 'python' ? 'it is a .py file' : `it lives under ${r.name}'s testDir`}) but ${r.name} is not resolvable for the ${mode === 'worktree' ? 'scratch worktree' : 'project'} (${c.message}).`);
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
            throw new PreconditionError(`${file} was listed by both ${previousOwner.name} and ${owner.name}; TestGuard cannot choose which configured runner owns it.`);
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
      ? sha256(JSON.stringify({ schemaVersion: 1, source: 'custom-command-static', files: allTests }))
      : hashNativeTestUniverse(manifests);
    const baselineCache = new Map();
    const discoveryHashCache = new Map();
    // The negative control is charged per (target file, defender set): two
    // claims over the same file with the same defenders ask the same question.
    const controlCache = new Map();
    // The runner that will LOAD the subject, which is not always the project
    // runner — a `.py` source file is Python's whatever the project runs.
    const fatalEditFor = (file) => runnerFor(iso.projectDir, file, runner).fatalEdit?.();
    const prior = previous && previous.run.confirmRuns === confirmRuns
      && sameWorkerPolicy(previous.run, { workers, serial, runnerCommand })
      ? new Map(previous.records.map((r) => [`${r.claim.id}/${r.subject.id}`, r]))
      : new Map();
    const partitionConfigured = (files) => {
      if (commandTemplate) return partitionByRunner(iso.projectDir, files, runner);
      const groups = new Map([[runner, []]]);
      for (const file of files) {
        const owner = ownerByFile.get(file);
        if (!owner) throw new PreconditionError(`${file} is not in any resolved runner's configured test universe`);
        if (!groups.has(owner)) groups.set(owner, []);
        groups.get(owner).push(file);
      }
      if (groups.get(runner).length === 0 && groups.size > 1) groups.delete(runner);
      return groups;
    };
    // `targets` are the fault's files, passed so a runner that can tell which
    // file the interpreter actually loaded (Python) reports it back.
    const runDefenders = async (files, targets = []) => {
      if (commandTemplate) {
        const result = await timedRun(runner, { projectDir: iso.projectDir, sourceDir: projectDir, python, files, budgetMs: commandBudget?.runBudget(budgetMs) ?? budgetMs, commandTemplate, serial, workers, targets });
        commandBudget?.assertOpen();
        return result;
      }
      const groups = partitionConfigured(files);
      const parts = [];
      for (const [r, group] of groups) {
        commandBudget?.assertOpen();
        if (r !== runner) await ensureOwned(r, group[0]);
        parts.push(await timedRun(r, { projectDir: iso.projectDir, sourceDir: projectDir, python, files: group, budgetMs: commandBudget?.runBudget(budgetMs) ?? budgetMs, serial, workers, targets }));
        commandBudget?.assertOpen();
      }
      return mergeRuns(parts);
    };
    /** Which runner each defender runs under, when more than the project runner is involved. */
    const byRunner = (files) => {
      const groups = partitionConfigured(files);
      if (groups.size <= 1) return undefined; // one runner ran them all, whichever it was
      return Object.fromEntries([...groups].map(([r, group]) => [labelOf(r), group]));
    };

    for (const claim of scopedClaims) {
      commandBudget?.assertOpen();
      for (const fault of claim.faults) {
        commandBudget?.assertOpen();
        const { requested } = defenderSelection(claim, fault);
        const declared = requested.length ? resolveDefenders(iso.projectDir, requested) : null;
        if (declared && !commandTemplate) {
          const excluded = declared.filter((file) => !ownerByFile.has(file));
          for (const file of excluded) {
            const expectedOwner = owned.find((candidate) => candidate.owns?.(iso.projectDir, file));
            const check = expectedOwner && ownedChecked.get(expectedOwner);
            if (expectedOwner && check && !check.ok) {
              throw new PreconditionError(`${file} is a ${expectedOwner.name} test (${expectedOwner.name === 'python' ? 'it is a .py file' : `it lives under ${expectedOwner.name}'s testDir`}) but ${expectedOwner.name} is not resolvable for the ${mode === 'worktree' ? 'scratch worktree' : 'project'} (${check.message}).`);
            }
          }
          if (excluded.length) throw new PreconditionError(`${claim.id}/${fault.id}: defendedBy resolves to ${excluded.join(', ')}, but the configured runners do not collect ${excluded.length === 1 ? 'that file' : 'those files'}`);
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
        let record;
        try {
          if (!declared && mockInfo.indeterminate.length > 0) {
            record = discoveryIndeterminateRecord({ ...common, inputs: safeInputs(iso.projectDir, fault, defenders, { testUniverseHash, discoveryHashes }), indeterminate: mockInfo.indeterminate });
          } else record = await probeOne({ ...common, allTests, iso, isoReal, onWarn, confirmRuns, escalate, baselineCache, controlCache, fatalEditFor, runDefenders, stage, prior: prior.get(`${claim.id}/${fault.id}`), priorRunId: previous?.run.id, testUniverseHash, discoveryHashes,
            historyRef: snapshot ?? (mode === 'worktree' ? head : 'HEAD'), historyDir: root,
            // A path from the runner is absolute inside the SCRATCH worktree, or
            // project-relative. Either way history is read from the real repository,
            // so both must land on a repo-root-relative path. The runner reports
            // realpaths (/private/var on macOS) while the worktree path may not be
            // one — realpath both sides or every comparison silently misses.
            toRepoPath: (p) => relative(root, join(projectDir, isAbsolute(p) ? relative(isoReal, realpathSync(p)) : p)) });
        } catch (err) {
          // A precondition failure is a statement about the whole run — the
          // interpreter is loading a different copy of the source, the runner
          // is not resolvable — and continuing would produce verdicts that are
          // all false. Everything else is this one fault's problem.
          if (err instanceof PreconditionError) throw err;
          record = errorRecord({ ...common, error: err, inputs: safeInputs(iso.projectDir, fault, defenders, { testUniverseHash, discoveryHashes }) });
          onWarn(`${claim.id}/${fault.id}: ${record.detail.message} — reported as unverifiable so the rest of the run still produces evidence.`);
        }
        records.push(record);
        onProgress(record);
      }
    }
  } finally {
    iso.cleanup();
  }

  commandBudget?.assertOpen();

  assertNotCancelled();
  const dirty = isDirty(root);
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
      runner: { name: labelOf(runner), ...((runnerVersion ?? readRunnerVersion(projectDir, runner.name)) ? { version: runnerVersion ?? readRunnerVersion(projectDir, runner.name) } : {}) },
      ...(runnersUsed.size > 1 ? { runners: [...runnersUsed].map(([n, v]) => ({ name: n, ...(v ? { version: v } : {}) })) } : {}),
      confirmRuns,
      measurements,
      ...(!runnerCommand ? { workers: serial ? 1 : workers } : {}),
      ...(serial && !runnerCommand ? { serial: true } : {}),
      ...(contention.detected ? { contention } : {}),
      ...(confirmRuns < 3 ? { provisional: true } : {}),
      // The isolation that was actually created, not the mode that was asked
      // for. A record saying `worktree` while the probe edited the project in
      // place would be a false statement about where the evidence came from,
      // and nothing downstream could detect it.
      mode: iso.mode,
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
  const key = `${file}\n${defenders.join('\n')}`;
  if (cache.has(key)) return cache.get(key);
  const content = fatalEditFor(file);
  // A runner that cannot say what "this cannot compile" looks like for its
  // language does not get to guess. No control, no signal, verdict unchanged.
  if (content == null) {
    cache.set(key, undefined);
    return undefined;
  }
  const control = applyContent(iso.projectDir, file, content, { inPlace: iso.mode === 'in-place' });
  let run;
  try {
    stage('negative-control', 1, 1);
    ({ run } = await runDefenders(defenders, [file]));
  } finally {
    control.restore();
  }
  const reached = run.outcome !== 'pass';
  cache.set(key, reached);
  return reached;
}

async function probeOne({ claim, fault, defenders, discovered, allTests, iso, isoReal, onWarn = () => {}, confirmRuns, escalate, baselineCache, controlCache, fatalEditFor, runDefenders, stage, prior, priorRunId, byRunner, mocking = [], signals = [], historyRef, historyDir, toRepoPath, testUniverseHash, discoveryHashes = {} }) {
  const targetPath = join(iso.projectDir, fault.file);
  const targetExists = existsSync(targetPath);
  const inputs = {
    targetHash: targetExists ? hashFile(targetPath) : sha256(''),
    defenderHashes: Object.fromEntries(defenders.map((f) => [f, hashFile(join(iso.projectDir, f))])),
    testUniverseHash,
    discoveryHashes,
  };

  const subject = subjectOf(fault, sha256);

  // Same source, same defenders, same N, same fault: the verdict cannot have changed.
  if (isReusable(prior, { claim, inputs, ...defenderSelection(claim, fault), resolved: defenders, contentHash: subject.contentHash })) {
    return { ...prior, defenders: { ...prior.defenders, ...defenderSelection(claim, fault) }, reusedFrom: prior.reusedFrom ?? priorRunId };
  }

  const detail = { baselineRuns: [], probeRuns: [] };
  const rawProbeRuns = []; // spec testRun + the runner's timeout count, which classify needs
  let anchor = null;
  let subjectReached; // the negative control's answer; undefined until it is worth asking

  if (defenders.length > 0) {
    anchor = targetExists ? locate(readFileSync(targetPath, 'utf8'), fault) : { status: 'file-missing', hits: 0, expected: fault.expectHits ?? 1 };

    if (anchor.status === 'ok') {
      const key = defenders.join('\n');
      if (!baselineCache.has(key)) {
        const runs = [];
        let loadMessage;
        for (let i = 0; i < confirmRuns; i++) {
          stage('baseline', i + 1, confirmRuns);
          const res = await runDefenders(defenders);
          runs.push(res.run);
          if (res.run.outcome !== 'pass') {
            loadMessage = res.loadMessage;
            break;
          }
        }
        // The decision stops at the first non-green run — nothing about this
        // fault can be trusted after it. But "failed once in three" and "fails
        // every time" are different problems for whoever has to fix the
        // defender, and the only way to tell them apart is to finish the runs.
        // Paid once per defender set, and only when it is already broken.
        if (runs.length < confirmRuns && runs[runs.length - 1].outcome === 'fail') {
          for (let i = runs.length; i < confirmRuns; i++) {
            stage('baseline-flake', i + 1, confirmRuns);
            runs.push((await runDefenders(defenders)).run);
          }
        }
        baselineCache.set(key, { runs, loadMessage });
      }
      const baseline = baselineCache.get(key);
      detail.baselineRuns = baseline.runs;
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

      if (detail.baselineRuns.every((r) => r.outcome === 'pass') && detail.baselineRuns.length === confirmRuns) {
        const mutation = applyFault(iso.projectDir, fault, { inPlace: iso.mode === 'in-place' });
        try {
          const probeRuns = rawProbeRuns;
          for (let i = 0; i < confirmRuns; i++) {
            stage('probe', i + 1, confirmRuns);
            const { run, timeouts, loadMessage, failedTests, provenance } = await runDefenders(defenders, [fault.file]);
            probeRuns.push({ ...run, timeouts, loadMessage, failedTests });
            // Only when the suite actually loaded. A run that failed to load
            // explains an absent import by itself — saying the defenders never
            // reached the file would be true and useless, and it would put the
            // signal on every fault whose replacement does not parse.
            if (i === 0 && run.outcome !== 'error') checkProvenance({ claim, fault, provenance, isoReal, detail, onWarn });
            if (shouldStopEarly(probeRuns)) break;
          }
          detail.probeRuns = probeRuns.map(({ timeouts, loadMessage, failedTests, ...run }) => run);
          const provisional = classify({ defenders, anchor, baselineRuns: detail.baselineRuns, probeRuns, confirmRuns });
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
            let state = escalationStart();
            for (let i = 0; i < confirmRuns; i++) {
              stage('escalation', i + 1, confirmRuns);
              state = foldEscalationRun(state, await runDefenders(allTests));
              if (state.stoppedEarly) break;
            }
            Object.assign(detail, escalationResult(state, confirmRuns));
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
    }
  }

  const { verdict, reason } = classify({ defenders, anchor, baselineRuns: detail.baselineRuns, probeRuns: rawProbeRuns, confirmRuns, subjectReached });
  if (reason && !detail.reason) detail.reason = reason;
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
