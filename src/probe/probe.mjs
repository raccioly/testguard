import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { repoRoot as gitRoot, headSha, isDirty } from '../git.mjs';
import { createScratch, inPlace, PreconditionError } from './worktree.mjs';
import { applyFault, locate } from './inject.mjs';
import * as vitest from './runner-vitest.mjs';
import { classify, shouldStopEarly } from './classify.mjs';
import { blastRadius, rank } from './rank.mjs';
import { hashFile, sha256 } from '../util/hash.mjs';
import { fingerprint } from '../../spec/lib/fingerprint.mjs';

const isKill = (r) => r.outcome === 'fail' && r.assertionFailures > 0;

function runnerVersion(projectDir) {
  try {
    return JSON.parse(readFileSync(createRequire(join(projectDir, 'noop.js')).resolve('vitest/package.json'), 'utf8')).version;
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
  budgetMs = 120_000,
  escalate = true,
  scratchBase,
  toolVersion = '0.0.0',
  previous,
  onProgress = () => {},
}) {
  projectDir = resolve(projectDir);
  const root = gitRoot(projectDir);
  const head = headSha(root);
  if (!head) throw new PreconditionError('repository has no commits; every verdict is tied to a commit');

  const targets = [...new Set(claims.claims.flatMap((c) => c.faults.map((f) => relative(root, join(projectDir, f.file)))))];
  if (mode === 'in-place' && isDirty(root, targets)) {
    throw new PreconditionError(`uncommitted changes in target files (${targets.join(', ')}); commit or stash first, or drop --in-place`);
  }

  const startedAt = new Date().toISOString();
  const iso = mode === 'worktree' ? createScratch({ repoRoot: root, projectDir, scratchBase }) : inPlace({ repoRoot: root, projectDir });
  const records = [];
  try {
    const allTests = vitest.listTestFiles(iso.projectDir);
    const baselineCache = new Map();
    const prior = previous && previous.run.confirmRuns === confirmRuns
      ? new Map(previous.records.map((r) => [`${r.claim.id}/${r.subject.id}`, r]))
      : new Map();
    const runDefenders = (files) => vitest.runVitest({ projectDir: iso.projectDir, files, budgetMs });

    for (const claim of claims.claims) {
      const defenders = vitest.resolveDefenders(iso.projectDir, claim.defendedBy);
      for (const fault of claim.faults) {
        const record = await probeOne({ claim, fault, defenders, allTests, iso, confirmRuns, escalate, baselineCache, runDefenders, prior: prior.get(`${claim.id}/${fault.id}`), priorRunId: previous?.run.id });
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
      repo: { head, dirty: isDirty(root) },
      runner: { name: vitest.name, ...(runnerVersion(projectDir) ? { version: runnerVersion(projectDir) } : {}) },
      confirmRuns,
      mode,
    },
    records,
  };
}

async function probeOne({ claim, fault, defenders, allTests, iso, confirmRuns, escalate, baselineCache, runDefenders, prior, priorRunId }) {
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
        for (let i = 0; i < confirmRuns; i++) {
          const { run } = await runDefenders(defenders);
          runs.push(run);
          if (run.outcome !== 'pass') break;
        }
        baselineCache.set(key, runs);
      }
      detail.baselineRuns = baselineCache.get(key);

      if (detail.baselineRuns.every((r) => r.outcome === 'pass') && detail.baselineRuns.length === confirmRuns) {
        const mutation = applyFault(iso.projectDir, fault);
        try {
          const probeRuns = rawProbeRuns;
          for (let i = 0; i < confirmRuns; i++) {
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
              const { run, failedTests } = await runDefenders(allTests);
              runs.push(run);
              killers = killers === null ? new Set(failedTests) : new Set(failedTests.filter((t) => killers.has(t)));
              if (killers.size === 0) break;
            }
            detail.escalated = true;
            detail.escalationRuns = runs;
            if (killers.size > 0 && runs.length === confirmRuns && runs.every(isKill)) detail.reason = 'killed-by-undeclared-tests';
          }
        } finally {
          mutation.restore();
        }
      }
    }
  }

  const { verdict, reason } = classify({ defenders, anchor, baselineRuns: detail.baselineRuns, probeRuns: rawProbeRuns, confirmRuns });
  if (reason && !detail.reason) detail.reason = reason;

  const blast = targetExists ? blastRadius(iso.projectDir, fault.file) : 0;

  return {
    fingerprint: fingerprint({ claimId: claim.id, subjectId: fault.id, file: fault.file, verdict }),
    claim: { id: claim.id, statement: claim.statement, severity: claim.severity, source: claim.source, producedBy: claim.producedBy },
    subject: { kind: 'fault', id: fault.id, description: fault.description, file: fault.file, faultClass: fault.faultClass, producedBy: fault.producedBy },
    verdict,
    detail,
    defenders: { requested: claim.defendedBy ?? [], resolved: defenders, nocover: defenders.length === 0 },
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
