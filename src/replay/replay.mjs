import { existsSync, rmSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { git, GitError, repoRoot, headSha } from '../git.mjs';
import { createScratch, PreconditionError } from '../probe/worktree.mjs';
import { selectRunner, RUNNERS } from '../probe/runners/index.mjs';
import { parseCommandTemplate } from '../probe/runners/shared.mjs';
import { fileImports } from '../probe/rank.mjs';
import { IS_PY_TEST, pyFileImports } from '../probe/pyimports.mjs';
import { labelDiff } from './label.mjs';

const TEST_RE = /(^|\/)(__tests__|tests?)\//;
const IS_TEST = (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || IS_PY_TEST.test(f) || TEST_RE.test(f);
const SOURCE_EXT = /\.([cm]?[jt]sx?|py)$/;

/**
 * Fix commits in a range: those that change source AND a test together.
 *
 * That pairing is the signal a human confirmed a defect — someone changed
 * behaviour and shipped a test for it — which is what makes bug replay ground
 * truth rather than a synthetic mutant of arguable relevance.
 */
export function findFixCommits({ dir, range, projectDir }) {
  // In a monorepo a fix commit routinely touches several packages. Only the
  // files under THIS project can be reverted or run here, so scope to them
  // and drop a commit that has no source-and-test pair inside the project —
  // otherwise most of the corpus comes back `revert-did-not-apply`, which
  // looks like a tooling failure and hides the real verdicts.
  const scope = projectDir && projectDir !== dir ? relative(dir, projectDir).split('\\').join('/') : '';
  const inScope = (f) => !scope || f === scope || f.startsWith(`${scope}/`);
  let log;
  try {
    log = git(['log', '--no-merges', '--format=%H%x1f%s', range], dir);
  } catch (e) {
    if (e instanceof GitError) throw new PreconditionError(`cannot read the range ${range}: ${e.message.split('\n')[0]}`);
    throw e;
  }
  const out = [];
  for (const line of log.split('\n').filter(Boolean)) {
    const [commit, subject] = line.split('\x1f');
    const files = git(['show', '--name-only', '--format=', '--diff-filter=d', commit], dir).split('\n').filter(Boolean);
    const source = files.filter((f) => inScope(f) && SOURCE_EXT.test(f) && !IS_TEST(f));
    const tests = files.filter((f) => inScope(f) && IS_TEST(f));
    if (source.length === 0 || tests.length === 0) continue;
    out.push({ commit, subject, source, tests });
  }
  return out;
}

/**
 * De-duplicate by patch-id. A dual-branch topology carries the same fix under
 * two or three shas; counting it twice corrupts the corpus the calibration is
 * computed from, and it was a real defect in the first harness.
 */
export function dedupeByPatch({ dir, commits }) {
  const seen = new Map();
  const unique = [];
  for (const c of commits) {
    // `git patch-id` reads the patch on stdin, which git() does not do.
    const r = spawnSync('git', ['patch-id', '--stable'], { cwd: dir, encoding: 'utf8', input: (() => { try { return git(['show', c.commit], dir); } catch { return ''; } })() });
    const patchId = r.status === 0 ? (r.stdout.trim().split(' ')[0] || null) : null;
    const id = patchId || c.commit;
    if (seen.has(id)) continue;
    seen.set(id, c.commit);
    unique.push({ ...c, patchId: id });
  }
  return { unique, duplicates: commits.length - unique.length };
}

/**
 * Would the suite as it stood have caught this bug?
 *
 * For each fix: check out the fix, revert ONLY its source files to the
 * parent, delete the test files the fix shipped, and run what remains. A
 * fix's own test proves nothing about what the suite knew before it.
 *
 * Runs in a scratch worktree; the caller's tree is never touched.
 */
export async function replay({
  projectDir,
  range,
  confirmRuns = 3,
  budgetMs = 120_000,
  runnerCommand,
  runnerName = 'auto',
  nodeModules,
  scratchBase,
  limit,
  toolVersion = '0.0.0',
  onProgress = () => {},
  onStage = () => {},
}) {
  projectDir = realpathSync(resolve(projectDir));
  const root = repoRoot(projectDir);
  if (!headSha(root)) throw new PreconditionError('repository has no commits; there is nothing to replay');

  const found = findFixCommits({ dir: root, range, projectDir });
  const { unique, duplicates } = dedupeByPatch({ dir: root, commits: found });
  const selected = limit ? unique.slice(0, limit) : unique;
  if (selected.length === 0) {
    throw new PreconditionError(`no fix commits in ${range}: a fix commit changes source and a test together. Widen the range, or this history has none.`);
  }

  const startedAt = new Date().toISOString();
  const records = [];
  let runnerUsed = RUNNERS[runnerName === 'auto' ? 'vitest' : runnerName];
  let runnerVersion;

  for (const [i, fix] of selected.entries()) {
    onStage({ commit: fix.commit, i: i + 1, n: selected.length, stage: 'prepare' });
    const iso = createScratch({ repoRoot: root, projectDir, ref: fix.commit, scratchBase, nodeModules });
    try {
      const commandTemplate = runnerCommand ? parseCommandTemplate(runnerCommand) : undefined;
      if (!commandTemplate) {
        const sel = await selectRunner({ projectDir: iso.projectDir, name: runnerName });
        if (sel.error) throw new PreconditionError(`test runner is not resolvable in the scratch worktree (${sel.error}). Pass --node-modules <path>.`);
        runnerUsed = sel.runner;
        runnerVersion = sel.version;
      }
      const record = await replayOne({ fix, iso, root, projectDir, confirmRuns, budgetMs, commandTemplate, runner: runnerUsed, onStage, index: i + 1, total: selected.length });
      records.push(record);
      onProgress(record);
    } finally {
      iso.cleanup();
    }
  }

  return {
    schemaVersion: 1,
    tool: { name: 'testguard', version: toolVersion },
    run: {
      id: `replay-${startedAt.replace(/[-:.]/g, '').slice(0, 15)}`,
      startedAt,
      finishedAt: new Date().toISOString(),
      range,
      runner: { name: runnerUsed.name, ...(runnerVersion ? { version: runnerVersion } : {}) },
      confirmRuns,
      candidates: found.length,
      duplicates,
    },
    records,
  };
}

async function replayOne({ fix, iso, root, projectDir, confirmRuns, budgetMs, commandTemplate, runner, onStage, index, total }) {
  // git reports paths from the REPOSITORY root; the runner and every file
  // operation here work inside the scratch worktree, relative to the PROJECT
  // directory. Map once, and refuse anything that would land outside the
  // worktree: this function deletes files, and a wrong mapping silently
  // deleted them from the real repository.
  const relProject = relative(root, projectDir).split('\\').join('/');
  const rel = (repoPath) => (relProject && repoPath.startsWith(`${relProject}/`) ? repoPath.slice(relProject.length + 1) : repoPath);
  const isoRoot = realpathSync(iso.projectDir);
  const inside = (p) => {
    const abs = realpathSync(dirname(p)) + '/' + basename(p);
    if (!abs.startsWith(isoRoot + '/')) throw new PreconditionError(`refusing to touch ${p}: outside the scratch worktree ${isoRoot}`);
    return abs;
  };
  const base = { commit: fix.commit, patchId: fix.patchId, subject: fix.subject, source: fix.source, removedTests: fix.tests };

  // The label comes from the fix's SOURCE diff only: a test diff describes
  // what was asserted, not what was broken.
  let faultClass;
  try {
    const diff = git(['show', '--format=', '--unified=0', fix.commit, '--', ...fix.source], root);
    faultClass = labelDiff(diff).faultClass;
  } catch {
    faultClass = 'other';
  }

  // Revert only the source, to the fix's parent. A fix routinely ADDS a file
  // as well as changing others, and a file that did not exist at the parent
  // cannot be checked out of it — reverting such a file means removing it.
  // Getting this wrong turns half a real corpus into `revert-did-not-apply`,
  // which reads as a tooling failure and hides every real verdict behind it.
  const existedBefore = [];
  const addedByTheFix = [];
  for (const f of fix.source) {
    try {
      git(['cat-file', '-e', `${fix.commit}^:${f}`], iso.projectDir);
      existedBefore.push(f);
    } catch {
      addedByTheFix.push(f);
    }
  }
  // Every source file is new: this commit ADDS behaviour rather than
  // correcting it. There is no earlier version to have been blind to, so it
  // is not a bug the suite could have caught, and it must not enter a
  // calibration as though it were.
  if (existedBefore.length === 0) {
    return { ...base, faultClass, verdict: 'unverifiable', reason: 'no-prior-version', runs: [{ outcome: 'error', durationMs: 0 }] };
  }
  try {
    if (existedBefore.length) git(['checkout', `${fix.commit}^`, '--', ...existedBefore.map(rel)], iso.projectDir);
    for (const f of addedByTheFix) {
      const abs = join(iso.projectDir, rel(f));
      if (existsSync(abs)) rmSync(inside(abs), { force: true });
    }
  } catch (e) {
    return { ...base, faultClass, verdict: 'unverifiable', reason: 'revert-did-not-apply', runs: [{ outcome: 'error', durationMs: 0 }] };
  }

  // A fix's own test proves nothing about what the suite knew before it.
  for (const t of fix.tests) {
    const inWorktree = join(iso.projectDir, rel(t));
    if (existsSync(inWorktree)) rmSync(inside(inWorktree), { force: true });
  }

  // What remains that could possibly notice: the test files importing any
  // reverted source file. `nocover` means nothing does — worse than blind,
  // and a coverage report shows it as a red line you can ignore.
  const all = runner.tests(iso.projectDir).filter((t) => !fix.tests.some((ft) => rel(ft) === t));
  const related = all.filter((t) => fix.source.some((sf) => fileImports(iso.projectDir, join(iso.projectDir, t), rel(sf))));
  if (related.length === 0) {
    return { ...base, faultClass, verdict: 'nocover', reason: 'no-test-imports-the-reverted-source', ranTests: 0, runs: [{ outcome: 'error', durationMs: 0 }] };
  }

  const runs = [];
  for (let i = 0; i < confirmRuns; i++) {
    onStage({ commit: fix.commit, i: index, n: total, stage: `run ${i + 1}/${confirmRuns}` });
    const res = await runner.run({ projectDir: iso.projectDir, files: related, budgetMs, commandTemplate });
    runs.push(res.run);
    // A suite that cannot load says nothing about the bug.
    if (res.run.outcome === 'error') return { ...base, faultClass, verdict: 'unverifiable', reason: 'suite-failed-to-load', ranTests: related.length, runs };
  }

  return { ...base, faultClass, ...classifyReplay(runs), ranTests: related.length, runs };
}

/**
 * Runs in, verdict out. Pure, so every branch is unit-testable — the same
 * discipline as the probe's `classify()`, for the same reason.
 *
 * The ordering matters. A flaky failure reads as "the suite detected it", so
 * flakiness biases this metric OPTIMISTICALLY and hides exactly the blind
 * spots the replay exists to find: mixed runs are never `caught`.
 */
export function classifyReplay(runs) {
  const isCatch = (r) => r.outcome === 'fail' && (r.assertionFailures ?? 0) > 0;
  if (runs.length === 0) return { verdict: 'unverifiable', reason: 'no-runs' };
  if (runs.some((r) => r.outcome === 'error')) return { verdict: 'unverifiable', reason: 'suite-failed-to-load' };
  if (runs.every(isCatch)) return { verdict: 'caught' };
  if (runs.every((r) => r.outcome === 'pass')) return { verdict: 'blind' };
  if (runs.some((r) => r.outcome === 'timeout')) return { verdict: 'unverifiable', reason: 'timed-out' };
  // A failure that is not an assertion failure is not detection either.
  if (runs.every((r) => r.outcome === 'fail') && !runs.every(isCatch)) return { verdict: 'unverifiable', reason: 'failed-without-an-assertion' };
  return { verdict: 'flaky', reason: 'runs-disagreed' };
}

/** Wilson score interval: the reason a label carries n rather than a vibe. */
export function wilson(positives, n, z = 1.96) {
  if (n === 0) return { p: 0, ci: [0, 1] };
  const p = positives / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  const round = (x) => Number(Math.min(1, Math.max(0, x)).toFixed(4));
  return { p: Number(p.toFixed(4)), ci: [round(centre - half), round(centre + half)] };
}

/**
 * Calibration from a replay document: per fault class, the share of real
 * escaped bugs of that shape the suite did NOT catch.
 *
 * Read it as "when a fault of this class survives, how often does that
 * correspond to a bug that really escaped" — the number that turns an
 * uninterpretable mutation score into a statement with a sample size.
 * `caught` and `blind` are the only outcomes that carry information;
 * `nocover`, `flaky` and `unverifiable` are excluded from both sides.
 */
export function calibrationFrom(replayDoc, { confidence = 0.95, computedAt = new Date().toISOString(), toolVersion } = {}) {
  const buckets = {};
  for (const r of replayDoc.records) {
    if (!['caught', 'blind'].includes(r.verdict)) continue;
    const key = r.faultClass ?? 'other';
    buckets[key] ??= { n: 0, positives: 0 };
    buckets[key].n += 1;
    if (r.verdict === 'blind') buckets[key].positives += 1;
  }
  for (const [k, b] of Object.entries(buckets)) buckets[k] = { ...b, ...wilson(b.positives, b.n) };
  return {
    schemaVersion: 1,
    tool: { name: 'testguard', version: toolVersion ?? replayDoc.tool.version },
    computedAt,
    method: 'wilson',
    confidence,
    bucketBy: 'faultClass',
    source: { kind: 'bug-replay', ref: replayDoc.run.range },
    buckets,
  };
}

export function renderReplay(doc) {
  const by = {};
  for (const r of doc.records) by[r.verdict] = (by[r.verdict] ?? 0) + 1;
  const lines = [];
  for (const r of doc.records) {
    if (r.verdict === 'caught') continue;
    lines.push(`${r.verdict.toUpperCase().padEnd(13)} ${r.commit.slice(0, 9)} ${(r.faultClass ?? 'other').padEnd(20)} ${r.ranTests ?? 0} test${r.ranTests === 1 ? '' : 's'} ran  ${r.subject ?? ''}${r.reason ? `  [${r.reason}]` : ''}`);
  }
  const order = ['blind', 'nocover', 'flaky', 'unverifiable', 'caught'];
  lines.push('');
  lines.push(`${doc.records.length} fix commit${doc.records.length === 1 ? '' : 's'} replayed from ${doc.run.candidates} candidate${doc.run.candidates === 1 ? '' : 's'}` +
    (doc.run.duplicates ? ` (${doc.run.duplicates} dropped as the same patch)` : '') + ': ' +
    order.filter((v) => by[v]).map((v) => `${by[v]} ${v}`).join(', ') + '.');
  const measurable = (by.caught ?? 0) + (by.blind ?? 0);
  if (measurable) lines.push(`${by.blind ?? 0} of ${measurable} measurable bugs were invisible to the suite — the escaped-bug replay rate is ${(((by.blind ?? 0) / measurable) * 100).toFixed(0)}%.`);
  lines.push('A bug that reached production is by construction one the suite missed, so a high rate is expected on a first run. The number to move is this one, over time.');
  return lines.join('\n');
}
