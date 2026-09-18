import { existsSync, readFileSync, realpathSync as fsRealpathSync } from 'node:fs';
import { git } from '../git.mjs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { repoRoot as gitRoot, headSha, isDirty, snapshotWorkingTree } from '../git.mjs';
import { discoverDefenders, discoverDefendersDetailed } from './discover.mjs';
import { classifyDefenders } from './mocks.mjs';
import { detectContention, contentionWarning } from './contention.mjs';
import { createScratch, inPlace, PreconditionError } from './worktree.mjs';
import { applyFault, locate } from './inject.mjs';
import { resolveDefenders, parseCommandTemplate } from './runners/shared.mjs';
import { selectRunner, RUNNERS, OWNED_RUNNERS, partitionByRunner, mergeRuns, runnerLabel } from './runners/index.mjs';
import { classify, shouldStopEarly } from './classify.mjs';
import { blastRadius, rank } from './rank.mjs';
import { classifyIndependence } from './independence.mjs';
import { escalationStart, foldEscalationRun, escalationResult, flakeRate, killersFromRuns, subjectOf, isReusable } from './attribution.mjs';
import { hashFile, sha256 } from '../util/hash.mjs';
import { fingerprint } from '../../spec/lib/fingerprint.mjs';


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
  serial = false,
  onWarn = () => {},
  budgetMs = 120_000,
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
  // realpath: git reports the repository root by its real path (/private/var
  // on macOS, not /var); every relative() below must start from the same place.
  projectDir = realpathSync(resolve(projectDir));
  const root = gitRoot(projectDir);
  if (mode === 'in-place' && ref !== 'HEAD') throw new PreconditionError('--ref needs a scratch worktree; drop --in-place');
  const head = headSha(root, ref);
  if (!head) throw new PreconditionError(ref === 'HEAD' ? 'repository has no commits; every verdict is tied to a commit' : `ref ${ref} does not resolve to a commit`);

  const targets = [...new Set(claims.claims.flatMap((c) => c.faults.map((f) => relative(root, join(projectDir, f.file)))))];
  if (mode === 'in-place' && isDirty(root, targets)) {
    throw new PreconditionError(`uncommitted changes in fault target files (${targets.join(', ')}); commit or stash them, or drop --in-place. Only the files faults are applied to must be clean — test files may be dirty, which is what makes --in-place usable while writing tests.`);
  }
  if (includeDirty && mode !== 'worktree') throw new PreconditionError('--include-dirty applies to worktree mode; drop --in-place');
  if (includeDirty && ref !== 'HEAD') throw new PreconditionError('--include-dirty snapshots the working tree; it cannot be combined with --ref');
  const selected = only ? new Set(only) : null;
  if (selected) {
    const known = new Set(claims.claims.map((c) => c.id));
    const unknown = [...selected].filter((id) => !known.has(id));
    if (unknown.length) throw new PreconditionError(`--claim: unknown claim id(s) ${unknown.join(', ')}`);
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
      if (isDirty(root)) snapshot = snapshotWorkingTree(root);
    } else {
      const watched = new Set(targets);
      for (const claim of claims.claims) {
        if (selected && !selected.has(claim.id)) continue;
        const declared = claim.defendedBy?.length ? resolveDefenders(projectDir, claim.defendedBy) : claim.faults.flatMap((f) => discoverDefenders(projectDir, f.file));
        for (const d of declared) watched.add(relative(root, join(projectDir, d)));
        for (const g of claim.defendedBy ?? []) if (!g.includes('*')) watched.add(relative(root, join(projectDir, g)));
      }
      const dirty = git(['status', '--porcelain', '--', ...watched], root).split('\n').filter(Boolean).map((l) => l.replace(/^[ MADRCU?!]{1,2}\s+/, '').replace(/^.* -> /, ''));
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

  const startedAt = new Date().toISOString();
  const iso = mode === 'worktree' ? createScratch({ repoRoot: root, projectDir, ref: snapshot ?? ref, scratchBase, nodeModules }) : inPlace({ repoRoot: root, projectDir });
  const isoReal = realpathSync(iso.projectDir);
  const records = [];
  let runnerVersion;
  let runnerSource;
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
      const sel = await selectRunner({ projectDir: iso.projectDir, sourceDir: projectDir, python, name: runnerName });
      if (sel.error) {
        throw new PreconditionError(`test runner is not resolvable in the ${mode === 'worktree' ? 'scratch worktree' : 'project'} (${sel.error}). ` +
          (mode === 'worktree' ? 'No usable node_modules was linked: pass --node-modules <path>, or run with --in-place.' : 'Install dependencies first.'));
      }
      runner = sel.runner;
      runnerVersion = sel.version;
      runnerSource = sel.source;
      if (sel.engine) engines.set(sel.runner, sel.engine);
    }
    runnersUsed.set(labelOf(runner), runnerVersion ?? readRunnerVersion(projectDir, runner.name));
    // Files an owning runner (Playwright) claims run under it, whatever the
    // project runner is; it must resolve before the first such defender runs.
    const owned = OWNED_RUNNERS.filter((r) => r !== runner);
    const ownedChecked = new Map();
    const ensureOwned = async (r, file) => {
      if (!ownedChecked.has(r)) ownedChecked.set(r, await r.check({ projectDir: iso.projectDir, sourceDir: projectDir, python }));
      const c = ownedChecked.get(r);
      if (!c.ok) throw new PreconditionError(`${file} is a ${r.name} test (${r.name === 'python' ? 'it is a .py file' : `it lives under ${r.name}'s testDir`}) but ${r.name} is not resolvable for the ${mode === 'worktree' ? 'scratch worktree' : 'project'} (${c.message}).`);
      if (c.engine) engines.set(r, c.engine);
      runnersUsed.set(labelOf(r), c.version);
    };
    const allTests = [...new Set([...runner.tests(iso.projectDir).filter((t) => !owned.some((r) => r.owns(iso.projectDir, t))), ...owned.flatMap((r) => r.tests(iso.projectDir))])].sort();
    const baselineCache = new Map();
    const prior = previous && previous.run.confirmRuns === confirmRuns
      ? new Map(previous.records.map((r) => [`${r.claim.id}/${r.subject.id}`, r]))
      : new Map();
    // `targets` are the fault's files, passed so a runner that can tell which
    // file the interpreter actually loaded (Python) reports it back.
    const runDefenders = async (files, targets = []) => {
      if (commandTemplate) return runner.run({ projectDir: iso.projectDir, sourceDir: projectDir, python, files, budgetMs, commandTemplate, serial, targets });
      const groups = partitionByRunner(iso.projectDir, files, runner);
      const parts = [];
      for (const [r, group] of groups) {
        if (r !== runner) await ensureOwned(r, group[0]);
        parts.push(await r.run({ projectDir: iso.projectDir, sourceDir: projectDir, python, files: group, budgetMs, serial, targets }));
      }
      return mergeRuns(parts);
    };
    /** Which runner each defender runs under, when more than the project runner is involved. */
    const byRunner = (files) => {
      const groups = partitionByRunner(iso.projectDir, files, runner);
      if (groups.size <= 1) return undefined; // one runner ran them all, whichever it was
      return Object.fromEntries([...groups].map(([r, group]) => [labelOf(r), group]));
    };

    for (const claim of claims.claims) {
      if (selected && !selected.has(claim.id)) continue;
      const declared = claim.defendedBy?.length ? resolveDefenders(iso.projectDir, claim.defendedBy) : null;
      for (const fault of claim.faults) {
        // Mock-awareness: a discovered file that mocks the target is not a
        // defender; a declared one that mocks it stays (the author named it)
        // but is listed, because a declared defender that mocks the subject
        // is a broken evidence chain the author should see.
        const mockInfo = declared ? classifyDefenders(iso.projectDir, fault.file, declared) : discoverDefendersDetailed(iso.projectDir, fault.file);
        const defenders = declared ?? mockInfo.canDetect;
        const stage = (name, i, n) => onStage({ claimId: claim.id, faultId: fault.id, stage: name, i, n });
        const record = await probeOne({ claim, fault, defenders, discovered: declared === null, allTests, iso, isoReal, onWarn, confirmRuns, escalate, baselineCache, runDefenders, stage, prior: prior.get(`${claim.id}/${fault.id}`), priorRunId: previous?.run.id, byRunner: byRunner(defenders), mocking: mockInfo.mocking, signals: mockInfo.signals,
          historyRef: snapshot ?? (mode === 'worktree' ? head : 'HEAD'), historyDir: root,
          // A path from the runner is absolute inside the SCRATCH worktree, or
          // project-relative. Either way history is read from the real repository,
          // so both must land on a repo-root-relative path. The runner reports
          // realpaths (/private/var on macOS) while the worktree path may not be
          // one — realpath both sides or every comparison silently misses.
          toRepoPath: (p) => relative(root, join(projectDir, isAbsolute(p) ? relative(isoReal, realpathSync(p)) : p)) });
        records.push(record);
        onProgress(record);
      }
    }
  } finally {
    iso.cleanup();
  }

  return {
    schemaVersion: 1,
    tool: { name: 'testguard', version: toolVersion },
    run: {
      id: `run-${startedAt.replace(/[-:.]/g, '').slice(0, 15)}`,
      startedAt,
      finishedAt: new Date().toISOString(),
      repo: { head, dirty: isDirty(root), ...(snapshot ? { snapshot } : {}), ...(ignoredDirty.length ? { ignoredDirty } : {}) },
      runner: { name: labelOf(runner), ...((runnerVersion ?? readRunnerVersion(projectDir, runner.name)) ? { version: runnerVersion ?? readRunnerVersion(projectDir, runner.name) } : {}) },
      ...(runnersUsed.size > 1 ? { runners: [...runnersUsed].map(([n, v]) => ({ name: n, ...(v ? { version: v } : {}) })) } : {}),
      confirmRuns,
      ...(serial ? { serial: true } : {}),
      ...(contention.detected ? { contention } : {}),
      ...(confirmRuns < 3 ? { provisional: true } : {}),
      // The isolation that was actually created, not the mode that was asked
      // for. A record saying `worktree` while the probe edited the project in
      // place would be a false statement about where the evidence came from,
      // and nothing downstream could detect it.
      mode: iso.mode,
    },
    records,
  };
}

async function probeOne({ claim, fault, defenders, discovered, allTests, iso, isoReal, onWarn = () => {}, confirmRuns, escalate, baselineCache, runDefenders, stage, prior, priorRunId, byRunner, mocking = [], signals = [], historyRef, historyDir, toRepoPath }) {
  const targetPath = join(iso.projectDir, fault.file);
  const targetExists = existsSync(targetPath);
  const inputs = {
    targetHash: targetExists ? hashFile(targetPath) : sha256(''),
    defenderHashes: Object.fromEntries(defenders.map((f) => [f, hashFile(join(iso.projectDir, f))])),
  };

  const subject = subjectOf(fault, sha256);

  // Same source, same defenders, same N, same fault: the verdict cannot have changed.
  if (isReusable(prior, { inputs, requested: claim.defendedBy ?? [], resolved: defenders, contentHash: subject.contentHash })) {
    return { ...prior, reusedFrom: prior.reusedFrom ?? priorRunId };
  }

  const detail = { baselineRuns: [], probeRuns: [] };
  const rawProbeRuns = []; // spec testRun + the runner's timeout count, which classify needs
  let anchor = null;

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
        const mutation = applyFault(iso.projectDir, fault);
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

          // Escalation: does anything *undeclared* catch it? A single run cannot
          // say — a flaky test elsewhere in the suite would take the credit — so
          // a test is an undeclared killer only if it fails in all N runs.
          const broader = allTests.filter((t) => !defenders.includes(t));
          if (provisional.verdict === 'survived' && escalate && broader.length > 0) {
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
        }
      }
    }
  }

  const { verdict, reason } = classify({ defenders, anchor, baselineRuns: detail.baselineRuns, probeRuns: rawProbeRuns, confirmRuns });
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

  return {
    fingerprint: fingerprint({ claimId: claim.id, subjectId: fault.id, file: fault.file, verdict }),
    claim: { id: claim.id, statement: claim.statement, severity: claim.severity, source: claim.source, producedBy: claim.producedBy },
    subject,
    verdict,
    detail,
    defenders: { requested: claim.defendedBy ?? [], resolved: defenders, nocover: defenders.length === 0, ...(discovered ? { discovered: true } : {}), ...(byRunner ? { byRunner } : {}), ...(mocking.length ? { mocking } : {}), ...(signals.length ? { signals } : {}) },
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
function checkProvenance({ claim, fault, provenance, isoReal, detail, onWarn }) {
  if (!provenance || !(fault.file in provenance)) return;
  const loaded = provenance[fault.file];
  if (loaded === null) {
    detail.targetNotImported = true;
    onWarn(`${claim.id}/${fault.id}: the defenders never imported ${fault.file}, so nothing they do could detect a fault in it. A verdict of "survived" here is a statement about the defenders' reach, not about their assertions.`);
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
