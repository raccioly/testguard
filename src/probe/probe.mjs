import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { git } from '../git.mjs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { repoRoot as gitRoot, headSha, isDirty, snapshotWorkingTree } from '../git.mjs';
import { discoverDefenders } from './discover.mjs';
import { createScratch, inPlace, PreconditionError } from './worktree.mjs';
import { applyFault, locate } from './inject.mjs';
import { resolveDefenders, parseCommandTemplate } from './runners/shared.mjs';
import { selectRunner, RUNNERS, OWNED_RUNNERS, partitionByRunner, mergeRuns } from './runners/index.mjs';
import { classify, shouldStopEarly } from './classify.mjs';
import { blastRadius, rank } from './rank.mjs';
import { hashFile, sha256 } from '../util/hash.mjs';
import { fingerprint } from '../../spec/lib/fingerprint.mjs';

const isKill = (r) => r.outcome === 'fail' && r.assertionFailures > 0;

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
  budgetMs = 120_000,
  runnerCommand,
  runnerName = 'auto',
  nodeModules,
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
  let snapshot;
  if (mode === 'worktree') {
    if (includeDirty) {
      if (isDirty(root)) snapshot = snapshotWorkingTree(root);
    } else if (ref === 'HEAD') {
      const watched = new Set(targets);
      for (const claim of claims.claims) {
        if (selected && !selected.has(claim.id)) continue;
        const declared = claim.defendedBy?.length ? resolveDefenders(projectDir, claim.defendedBy) : claim.faults.flatMap((f) => discoverDefenders(projectDir, f.file));
        for (const d of declared) watched.add(relative(root, join(projectDir, d)));
        for (const g of claim.defendedBy ?? []) if (!g.includes('*')) watched.add(relative(root, join(projectDir, g)));
      }
      const dirty = git(['status', '--porcelain', '--', ...watched], root).split('\n').filter(Boolean).map((l) => l.replace(/^[ MADRCU?!]{1,2}\s+/, '').replace(/^.* -> /, ''));
      if (dirty.length) {
        throw new PreconditionError(`${dirty.length} defender/target file${dirty.length === 1 ? ' has' : 's have'} uncommitted changes (${dirty.join(', ')}); worktree mode probes HEAD (${head.slice(0, 7)}), so those changes would be silently ignored. Commit them, run with --include-dirty to probe the working tree, or use --in-place.`);
      }
    }
  }
  const startedAt = new Date().toISOString();
  const iso = mode === 'worktree' ? createScratch({ repoRoot: root, projectDir, ref: snapshot ?? ref, scratchBase, nodeModules }) : inPlace({ repoRoot: root, projectDir });
  const records = [];
  let runnerVersion;
  let runner = RUNNERS[runnerName === 'auto' ? 'vitest' : runnerName];
  try {
    const commandTemplate = runnerCommand ? parseCommandTemplate(runnerCommand) : undefined;
    if (!commandTemplate) {
      // An unresolvable runner is a precondition failure, not a flaky defender.
      const sel = await selectRunner({ projectDir: iso.projectDir, name: runnerName });
      if (sel.error) {
        throw new PreconditionError(`test runner is not resolvable in the ${mode === 'worktree' ? 'scratch worktree' : 'project'} (${sel.error}). ` +
          (mode === 'worktree' ? 'No usable node_modules was linked: pass --node-modules <path>, or run with --in-place.' : 'Install dependencies first.'));
      }
      runner = sel.runner;
      runnerVersion = sel.version;
    }
    // Files an owning runner (Playwright) claims run under it, whatever the
    // project runner is; it must resolve before the first such defender runs.
    const owned = OWNED_RUNNERS.filter((r) => r !== runner);
    const ownedChecked = new Map();
    const runnersUsed = new Map();
    const ensureOwned = async (r, file) => {
      if (!ownedChecked.has(r)) ownedChecked.set(r, await r.check({ projectDir: iso.projectDir }));
      const c = ownedChecked.get(r);
      if (!c.ok) throw new PreconditionError(`${file} is a ${r.name} test (it lives under ${r.name}'s testDir) but ${r.name} is not resolvable in the ${mode === 'worktree' ? 'scratch worktree' : 'project'} (${c.message}).`);
      runnersUsed.set(r.name, c.version);
    };
    const allTests = [...new Set([...runner.tests(iso.projectDir).filter((t) => !owned.some((r) => r.owns(iso.projectDir, t))), ...owned.flatMap((r) => r.tests(iso.projectDir))])].sort();
    const baselineCache = new Map();
    const prior = previous && previous.run.confirmRuns === confirmRuns
      ? new Map(previous.records.map((r) => [`${r.claim.id}/${r.subject.id}`, r]))
      : new Map();
    const runDefenders = async (files) => {
      if (commandTemplate) return runner.run({ projectDir: iso.projectDir, files, budgetMs, commandTemplate });
      const groups = partitionByRunner(iso.projectDir, files, runner);
      const parts = [];
      for (const [r, group] of groups) {
        if (r !== runner) await ensureOwned(r, group[0]);
        parts.push(await r.run({ projectDir: iso.projectDir, files: group, budgetMs }));
      }
      return mergeRuns(parts);
    };
    /** Which runner each defender runs under, when more than the project runner is involved. */
    const byRunner = (files) => {
      const groups = partitionByRunner(iso.projectDir, files, runner);
      if (groups.size <= 1 && groups.has(runner)) return undefined;
      return Object.fromEntries([...groups].map(([r, group]) => [r.name, group]));
    };

    for (const claim of claims.claims) {
      if (selected && !selected.has(claim.id)) continue;
      const declared = claim.defendedBy?.length ? resolveDefenders(iso.projectDir, claim.defendedBy) : null;
      for (const fault of claim.faults) {
        const defenders = declared ?? discoverDefenders(iso.projectDir, fault.file);
        const stage = (name, i, n) => onStage({ claimId: claim.id, faultId: fault.id, stage: name, i, n });
        const record = await probeOne({ claim, fault, defenders, discovered: declared === null, allTests, iso, confirmRuns, escalate, baselineCache, runDefenders, stage, prior: prior.get(`${claim.id}/${fault.id}`), priorRunId: previous?.run.id, byRunner: byRunner(defenders) });
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
      repo: { head, dirty: isDirty(root), ...(snapshot ? { snapshot } : {}) },
      runner: { name: runner.name, ...((runnerVersion ?? readRunnerVersion(projectDir, runner.name)) ? { version: runnerVersion ?? readRunnerVersion(projectDir, runner.name) } : {}) },
      ...(runnersUsed.size ? { runners: [...runnersUsed].map(([n, v]) => ({ name: n, ...(v ? { version: v } : {}) })) } : {}),
      confirmRuns,
      ...(confirmRuns < 3 ? { provisional: true } : {}),
      mode,
    },
    records,
  };
}

async function probeOne({ claim, fault, defenders, discovered, allTests, iso, confirmRuns, escalate, baselineCache, runDefenders, stage, prior, priorRunId, byRunner }) {
  const targetPath = join(iso.projectDir, fault.file);
  const targetExists = existsSync(targetPath);
  const inputs = {
    targetHash: targetExists ? hashFile(targetPath) : sha256(''),
    defenderHashes: Object.fromEntries(defenders.map((f) => [f, hashFile(join(iso.projectDir, f))])),
  };

  // Same source, same defenders, same N: the verdict cannot have changed.
  if (prior && sameInputs(prior, inputs, claim.defendedBy ?? [], defenders)) {
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
        baselineCache.set(key, { runs, loadMessage });
      }
      const baseline = baselineCache.get(key);
      detail.baselineRuns = baseline.runs;
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
            const { run, timeouts, loadMessage } = await runDefenders(defenders);
            probeRuns.push({ ...run, timeouts, loadMessage });
            if (shouldStopEarly(probeRuns)) break;
          }
          detail.probeRuns = probeRuns.map(({ timeouts, loadMessage, ...run }) => run);
          const provisional = classify({ defenders, anchor, baselineRuns: detail.baselineRuns, probeRuns, confirmRuns });

          // Escalation: does anything *undeclared* catch it? A single run cannot
          // say — a flaky test elsewhere in the suite would take the credit — so
          // a test is an undeclared killer only if it fails in all N runs.
          const broader = allTests.filter((t) => !defenders.includes(t));
          if (provisional.verdict === 'survived' && escalate && broader.length > 0) {
            const runs = [];
            let killers = null;
            for (let i = 0; i < confirmRuns; i++) {
              stage('escalation', i + 1, confirmRuns);
              const { run, failedTests } = await runDefenders(allTests);
              runs.push(run);
              killers = killers === null ? new Set(failedTests) : new Set(failedTests.filter((t) => killers.has(t)));
              if (killers.size === 0) break;
            }
            detail.escalated = true;
            detail.escalationRuns = runs;
            if (killers.size > 0 && runs.length === confirmRuns && runs.every(isKill)) {
              detail.reason = 'killed-by-undeclared-tests';
              detail.undeclaredKillers = [...killers].sort();
            }
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

  return {
    fingerprint: fingerprint({ claimId: claim.id, subjectId: fault.id, file: fault.file, verdict }),
    claim: { id: claim.id, statement: claim.statement, severity: claim.severity, source: claim.source, producedBy: claim.producedBy },
    subject: { kind: 'fault', id: fault.id, description: fault.description, file: fault.file, faultClass: fault.faultClass, producedBy: fault.producedBy, contentHash: sha256(`${fault.find}\n${fault.replace}`) },
    verdict,
    detail,
    defenders: { requested: claim.defendedBy ?? [], resolved: defenders, nocover: defenders.length === 0, ...(discovered ? { discovered: true } : {}), ...(byRunner ? { byRunner } : {}) },
    inputs,
    rank: rank({ severity: claim.severity, sourceKind: claim.source.kind, blast }),
  };
}

function sameInputs(prior, inputs, requested, resolved) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return prior.inputs.targetHash === inputs.targetHash
    && same(prior.inputs.defenderHashes, inputs.defenderHashes)
    && same(prior.defenders.requested, requested)
    && same(prior.defenders.resolved, resolved);
}
