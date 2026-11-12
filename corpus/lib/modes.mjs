/**
 * Every mode the harness runs a subject under. Each mode returns the same
 * shape (see `result`), and a mode that measured nothing is a failure: an
 * empty comparison proves nothing.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, checkKey, differential, expectedFor } from './checks.mjs';
import { commitEdits, git, listing, prepareRepo, readOnlyNodeModules, unlockAndRemove } from './subject.mjs';
import { probe, verdictMap } from './tool.mjs';

export const MODES = ['reference', 'twice', 'reuse', 'default', 'workers-2', 'workers-4', 'typecheck', 'changed', 'partial', 'scratch', 'assertion-kill', 'reorder', 'noise'];

/** Modes that only apply to some subjects. */
export function applies(mode, subject) {
  if (mode === 'typecheck') return Boolean(subject.config.typecheck);
  if (mode === 'changed') return Boolean(subject.key.modes?.changed);
  if (mode === 'noise') return Boolean(subject.config.noise);
  return true;
}

function runSummary(label, r) {
  const m = r.evidence?.run?.measurements ?? {};
  const out = { label, exit: r.exit, elapsedMs: Math.round(r.elapsedMs), runnerInvocations: m.runnerInvocations ?? null, records: r.evidence?.records?.length ?? 0, reuse: r.evidence?.run?.reuse ?? null };
  // The tool wrote no evidence: a refusal (its own validator, a precondition)
  // or a crash. Reported as that, with the tool's reason, never as N wrong verdicts.
  if (!r.evidence) out.noEvidence = refusalReason(r);
  if (r.untouched) out.untouched = { emptySnapshot: r.untouched.emptySnapshot, changes: r.untouched.changes.slice(0, 20), changed: r.untouched.changes.length };
  return out;
}

export function refusalReason(r) {
  const fromJson = r.json?.error?.message;
  const lines = String(r.stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines.find((l) => /^error:|refusing|precondition|does not conform/i.test(l)) ?? lines[lines.length - 1] ?? '';
  return { exit: r.exit, kind: r.json?.error?.kind ?? null, reason: String(fromJson ?? first).slice(0, 500) };
}

function result(mode, subject, { runs, key = null, diff = null, checks = [], error = null }) {
  const measured = runs.reduce((n, r) => n + r.records, 0);
  const extra = [...checks];
  for (const run of runs) {
    if (run.noEvidence && !run.expectNoEvidence) extra.push(check('tool-wrote-evidence', false, { run: run.label, ...run.noEvidence }));
  }
  // Critical, never excusable: the tool modified the project it measured.
  for (const run of runs) {
    if (!run.untouched) { extra.push(check('subject-untouched', false, { run: run.label, note: 'no snapshot was taken' })); continue; }
    if (run.untouched.emptySnapshot) extra.push(check('subject-untouched', false, { run: run.label, note: 'the snapshot was empty: nothing was compared' }));
    else if (run.untouched.changed > 0) extra.push({ ...check('subject-untouched', false, { run: run.label, ...run.untouched }), critical: true, summary: `tool modified the subject: ${run.untouched.changes.map((c) => c.path).join(', ')}` });
    else extra.push(check('subject-untouched', true, { run: run.label }));
  }
  if (!error && measured === 0 && !checks.some((c) => c.allowEmpty)) extra.push(check('measured-something', false, 'the mode produced no records: an empty comparison is a failure'));
  const ok = !error && (!key || (key.wrong === 0 && key.critical === 0)) && (!diff || diff.equal) && extra.every((c) => c.ok);
  return { subject: subject.name, mode, ok, error, runs, key, differential: diff, checks: extra };
}

const out = (dir, name) => join(dir, '..', `${name}.evidence.json`);

async function freshProbe(ctx, label, args, { edits, prepare, env } = {}) {
  const repo = prepareRepo(ctx.subject, { scratchRoot: ctx.work });
  if (prepare) prepare(repo);
  if (edits) commitEdits(repo, edits.edits, edits.message);
  const r = await probe({ toolRoot: ctx.toolRoot, subject: ctx.subject, repo, outPath: out(repo, label), args: [...args, ...sliceArgs(ctx)], python: ctx.python, env });
  return { repo, r };
}

/**
 * A mode run on half the claims (`--slice 1/2`, #305): the probe names its
 * claims, and the key and the comparison are judged over those faults only.
 * The scorecard checks that the slices together cover every fault once.
 */
const sliceArgs = (ctx) => (ctx.slice ? ['--claim', ctx.slice.claims.join(',')] : []);

export function sliceOf(subject, index, of) {
  const claims = [...new Set(subject.faultIds.map((id) => id.split('/')[0]))];
  const mine = claims.filter((_, i) => i % of === index - 1);
  return { index, of, claims: mine, ids: subject.faultIds.filter((id) => mine.includes(id.split('/')[0])) };
}

function keyAndDiff(ctx, mode, r, { ids = ctx.slice?.ids, deltas, expected } = {}) {
  const observed = verdictMap(r.evidence);
  // No evidence is its own outcome (tool-wrote-evidence), not a key comparison.
  if (!r.evidence) return { observed, key: null, diff: null };
  const key = checkKey({ subject: ctx.subject, mode, map: observed.map, expected: expected ?? expectedFor(ctx.subject, mode), ids, known: ctx.known });
  let diff = null;
  if (ctx.reference) diff = differential({ reference: ctx.reference, observed, ids, deltas });
  // The reference runs in another job (#305): hand the answers to the scorecard, which judges them.
  else if (ctx.deferDifferential) ctx.pending.push({ observed, ids, deltas });
  return { observed, key, diff };
}

const exitCheck = (r) => check('exit-code', r.exit === 0 || r.exit === 1, `exit ${r.exit}${r.exit >= 2 ? `: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`);

export const RUN = {
  /** Serial (--serial and an explicit --fault-workers 1: one fault at a time, since #270 made a fan-out the default), --no-reuse, a fresh process and a fresh repository: the oracle for every other mode. */
  async reference(ctx) {
    const { repo, r } = await freshProbe(ctx, 'reference', ['--no-reuse', '--serial', '--fault-workers', '1']);
    const { observed, key } = keyAndDiff({ ...ctx, reference: null, deferDifferential: false }, 'reference', r);
    if (r.evidence) ctx.reference = observed;
    ctx.referenceRepo = repo;
    ctx.referenceElapsedMs = r.elapsedMs;
    return result('reference', ctx.subject, { runs: [runSummary('reference', r)], key, checks: [exitCheck(r), check('every-fault-reported', observed.order.length === ctx.subject.faultIds.length, `${observed.order.length} of ${ctx.subject.faultIds.length}`), check('serial-recorded', !r.evidence || (r.evidence.run?.faultWorkers ?? 1) === 1, `run.faultWorkers ${r.evidence?.run?.faultWorkers ?? 1}`)] });
  },

  /** Metamorphic: the same probe again, in the same repository: nothing may change. */
  async twice(ctx) {
    const runs = [];
    const checks = [];
    // The reference ran in another job: this mode takes its own first probe, as serial as the reference, so there is a repository to probe again.
    if (!ctx.referenceRepo) {
      const first = await freshProbe(ctx, 'twice-first', ['--no-reuse', '--serial', '--fault-workers', '1']);
      ctx.referenceRepo = first.repo;
      runs.push(runSummary('first', first.r));
      checks.push({ ...exitCheck(first.r), check: 'first-run-exit-code' });
    }
    const r = await probe({ toolRoot: ctx.toolRoot, subject: ctx.subject, repo: ctx.referenceRepo, outPath: out(ctx.referenceRepo, 'twice'), args: ['--no-reuse', ...sliceArgs(ctx)], python: ctx.python });
    const { observed, key, diff } = keyAndDiff(ctx, 'twice', r);
    if (ctx.slice) checks.push(check('slice-faults-reported', JSON.stringify([...observed.order].sort()) === JSON.stringify([...ctx.slice.ids].sort()), { expected: ctx.slice.ids, reported: observed.order }));
    return result('twice', ctx.subject, { runs: [...runs, runSummary('twice', r)], key, diff, checks: [...checks, exitCheck(r)] });
  },

  /**
   * Reuse in three steps on one repository: unchanged (everything carried
   * forward must be what the reference measured); after the keyed edit to an
   * imported file (the faults that import it are measured again and their
   * answers follow the post-edit key); after a simulated tool-version change
   * (nothing may be carried forward).
   */
  async reuse(ctx) {
    const repo = prepareRepo(ctx.subject, { scratchRoot: ctx.work });
    const evidencePath = out(repo, 'reuse');
    const p = (args, toolRoot = ctx.toolRoot) => probe({ toolRoot, subject: ctx.subject, repo, outPath: evidencePath, args, python: ctx.python });
    const runs = [];
    const checks = [];
    const seed = await p(['--no-reuse']);
    runs.push(runSummary('seed', seed));
    const unchanged = await p([]);
    runs.push(runSummary('unchanged', unchanged));
    const a = keyAndDiff(ctx, 'reuse', unchanged);
    // GATE-SEMANTICS rules 8 and 11, read without the tool: a record may be
    // carried forward unless its verdict is timeout or flaky-defender, its
    // reason is probe-error, defenders-failed-to-load or not-reached, or its
    // import closure is not complete. With nothing changed, every record that
    // may be carried forward must be, and nothing else may be.
    const mayReuse = (r) => !['timeout', 'flaky-defender'].includes(r.verdict)
      && !['probe-error', 'defenders-failed-to-load', 'not-reached-within-budget'].includes(r.detail?.reason)
      && r.inputs?.dependencyClosure === 'complete';
    // Rule 8 also needs one live green baseline of the defender set before a
    // carry-forward: on a set the seed found not green (a planted flaky test)
    // that run may pass or fail, so either outcome is accepted there.
    const setOf = (r) => JSON.stringify([...(r.defenders?.requested ?? [])].sort());
    const unstable = new Set((seed.evidence?.records ?? []).filter((r) => r.detail?.reason === 'defenders-not-green').map(setOf));
    const seedById = new Map((seed.evidence?.records ?? []).map((r) => [`${r.claim.id}/${r.subject.id}`, r]));
    const wrongReuse = (unchanged.evidence?.records ?? []).flatMap((r) => {
      const id = `${r.claim.id}/${r.subject.id}`;
      const prior = seedById.get(id);
      const want = Boolean(prior && mayReuse(prior));
      if (want && unstable.has(setOf(prior))) return [];
      return want === Boolean(r.reusedFrom) ? [] : [{ fault: id, reused: Boolean(r.reusedFrom), mayReuse: want, closure: prior?.inputs?.dependencyClosure ?? null }];
    });
    checks.push(check('unchanged-reuses-exactly-the-reusable', wrongReuse.length === 0 && (unchanged.evidence?.records ?? []).length > 0, wrongReuse.length ? wrongReuse : unchanged.evidence?.run?.reuse));
    const spec = ctx.subject.key.modes?.['reuse-edit'];
    let key = a.key;
    if (spec) {
      commitEdits(repo, spec.edits, 'corpus: reuse edit');
      const edited = await p([]);
      runs.push(runSummary('after-edit', edited));
      checks.push(exitCheck(edited));
      const b = keyAndDiff({ ...ctx, reference: null, deferDifferential: false }, 'reuse-edit', edited);
      const notRemeasured = spec.mustRemeasure.filter((id) => b.observed.map[id]?.reused !== false);
      checks.push(check('edit-remeasures-importers', notRemeasured.length === 0, notRemeasured.length ? { reusedAfterTheirImportChanged: notRemeasured } : `${spec.mustRemeasure.length} measured again`));
      key = mergeKey(key, b.key);
      const bumped = bumpedTool(ctx);
      try {
        const version = await p([], bumped);
        runs.push(runSummary('after-version-change', version));
        checks.push(exitCheck(version));
        const c = keyAndDiff({ ...ctx, reference: null, deferDifferential: false }, 'reuse-edit', version);
        checks.push(check('version-change-reuses-nothing', (version.evidence?.run?.reuse?.reused ?? -1) === 0, version.evidence?.run?.reuse));
        key = mergeKey(key, c.key);
      } finally { rmSync(bumped, { recursive: true, force: true }); }
    }
    for (const r of [seed, unchanged]) checks.push(exitCheck(r));
    return result('reuse', ctx.subject, { runs, key, diff: a.diff, checks });
  },

  default: (ctx) => defaultWidth(ctx),
  'workers-2': (ctx) => workers(ctx, 2),
  'workers-4': (ctx) => workers(ctx, 4),

  /** --typecheck: equal to the reference except for the faults the key says the checker refuses. */
  async typecheck(ctx) {
    const { r } = await freshProbe(ctx, 'typecheck', ['--no-reuse', '--typecheck']);
    const deltas = Object.keys(ctx.subject.key.modes?.typecheck?.expected ?? {});
    const { key, diff } = keyAndDiff(ctx, 'typecheck', r, { deltas });
    return result('typecheck', ctx.subject, { runs: [runSummary('typecheck', r)], key, diff, checks: [exitCheck(r), check('typecheck-declared', Boolean(r.evidence?.run?.typecheck), r.evidence?.run?.typecheck ?? 'run.typecheck missing')] });
  },

  /**
   * --changed over scripted commits: each selects exactly the keyed claims, and
   * what it selects is answered as the reference answered it. Then a reference
   * git cannot resolve: a precondition failure, never an empty change.
   */
  async changed(ctx) {
    const spec = ctx.subject.key.modes.changed;
    const repo = prepareRepo(ctx.subject, { scratchRoot: ctx.work });
    const runs = [];
    const checks = [];
    let key = null;
    let diff = null;
    for (const step of spec.steps) {
      commitEdits(repo, step.edits, `corpus: ${step.name}`);
      const r = await probe({ toolRoot: ctx.toolRoot, subject: ctx.subject, repo, outPath: out(repo, `changed-${step.name}`), args: ['--no-reuse', '--changed', 'HEAD~1'], python: ctx.python });
      if (step.expectedClaims.length === 0) {
        // A determined change that reaches no claim: exit 0, selectedCount 0,
        // no evidence written. Anything probed is a wrong selection.
        const scope = r.json?.run?.scope;
        const selected = [...new Set((r.evidence?.records ?? []).map((x) => x.claim.id))].sort();
        runs.push({ ...runSummary(step.name, r), expectNoEvidence: true });
        const ok = r.exit === 0 && !r.evidence && scope?.selectedCount === 0 && scope?.changed?.outcome === 'determined';
        const c = check(`selection:${step.name}`, ok, { expected: [], selected, exit: r.exit, scope: scope ?? null, wroteEvidence: Boolean(r.evidence) });
        if (!ok) {
          const k = ctx.known.find((x) => x.subject === ctx.subject.name && x.check === c.check && JSON.stringify([...x.observed.selected].sort()) === JSON.stringify(selected));
          if (k) { c.ok = true; c.detail.knownIssue = k.issue; c.detail.unsound = false; }
        }
        checks.push(c);
        c.allowEmpty = true;
        continue;
      }
      runs.push(runSummary(step.name, r));
      const selected = [...new Set((r.evidence?.records ?? []).map((x) => x.claim.id))].sort();
      const want = [...step.expectedClaims].sort();
      const exact = JSON.stringify(selected) === JSON.stringify(want);
      const c = check(`selection:${step.name}`, exact, { expected: want, selected });
      // A wrong selection passes only when a reviewed known failure names this
      // exact selection and its issue (a superset is imprecise; a subset is
      // unsound and is marked as such). The key and reference are then
      // compared over what was actually selected.
      let basis = want;
      if (!exact) {
        const k = ctx.known.find((x) => x.subject === ctx.subject.name && x.check === c.check && JSON.stringify([...x.observed.selected].sort()) === JSON.stringify(selected));
        if (k) { c.ok = true; c.detail.knownIssue = k.issue; c.detail.unsound = !want.every((id) => selected.includes(id)); basis = selected; }
      }
      checks.push(c);
      const ids = ctx.subject.faultIds.filter((id) => basis.includes(id.split('/')[0]));
      const k = keyAndDiff(ctx, 'changed', r, { ids });
      key = mergeKey(key, k.key);
      diff = mergeDiff(diff, k.diff);
      checks.push(exitCheck(r));
    }
    if (spec.badRef) {
      const bad = await probe({ toolRoot: ctx.toolRoot, subject: ctx.subject, repo, outPath: out(repo, 'changed-bad-ref'), args: ['--no-reuse', '--changed', spec.badRef.ref], python: ctx.python });
      runs.push({ ...runSummary('bad-ref', bad), expectNoEvidence: true });
      checks.push(check('unmeasurable-change-is-a-precondition-failure', bad.exit === spec.badRef.exit && !bad.evidence, { exit: bad.exit, wroteEvidence: Boolean(bad.evidence), stderr: bad.stderr.trim().split('\n').pop() }));
    }
    return result('changed', ctx.subject, { runs, key, diff, checks });
  },

  /**
   * --partial-on-budget with a command budget too small for any fault to be
   * fully measured on any machine (each needs at least six runner starts). The
   * document must still name every fault; whatever was reached must be what
   * the key says; everything else is unverifiable/not-reached-within-budget.
   */
  async partial(ctx) {
    const budget = ctx.subject.config.partialBudgetMs ?? 1000;
    const { r } = await freshProbe(ctx, 'partial', ['--no-reuse', '--command-budget', String(budget), '--partial-on-budget']);
    const records = r.evidence?.records ?? [];
    const observed = verdictMap(r.evidence);
    const notReached = records.filter((x) => x.verdict === 'unverifiable' && x.detail?.reason === 'not-reached-within-budget').map((x) => `${x.claim.id}/${x.subject.id}`);
    const reached = observed.order.filter((id) => !notReached.includes(id));
    const b = r.evidence?.run?.budget;
    const checks = [
      check('exit-never-zero', r.exit === 1 || r.exit === 2, `exit ${r.exit}`),
      check('every-fault-named', observed.order.length === ctx.subject.faultIds.length && JSON.stringify(observed.order) === JSON.stringify(ctx.subject.faultIds), `${observed.order.length} of ${ctx.subject.faultIds.length}`),
      check('budget-exhausted', b?.exhausted === true && notReached.length > 0, b ?? 'run.budget missing'),
      check('budget-counts-agree', b && b.reached === reached.length && b.notReached === notReached.length, { budget: b, reached: reached.length, notReached: notReached.length }),
      check('not-reached-records-are-empty', records.filter((x) => notReached.includes(`${x.claim.id}/${x.subject.id}`)).every((x) => (x.detail.probeRuns ?? []).length === 0 && !x.reusedFrom), 'not-reached records carry no runs and no reuse'),
    ];
    const key = reached.length ? checkKey({ subject: ctx.subject, mode: 'partial', map: observed.map, expected: expectedFor(ctx.subject, 'reference'), ids: reached, known: ctx.known }) : null;
    const res = result('partial', ctx.subject, { runs: [runSummary('partial', r)], key, checks });
    res.partial = { budgetMs: budget, reached: reached.length, notReached: notReached.length };
    return res;
  },

  /**
   * --scratch-dir with node_modules a read-only copy: same verdicts, nothing
   * written through node_modules, nothing left in the scratch directory.
   */
  async scratch(ctx) {
    const root = mkdtempSync(join(ctx.work, 'scratch-mode-'));
    const scratchDir = join(root, 'scratch');
    mkdirSync(scratchDir);
    const ro = ctx.subject.config.install === 'npm' && ctx.subject.config.readOnlyNodeModules?.applies !== false ? readOnlyNodeModules(ctx.subject, root) : null;
    const before = ro ? listing(ro) : null;
    try {
      const repo = prepareRepo(ctx.subject, { scratchRoot: ctx.work, nodeModules: ro ?? undefined });
      const r = await probe({ toolRoot: ctx.toolRoot, subject: ctx.subject, repo, outPath: out(repo, 'scratch'), args: ['--no-reuse', '--scratch-dir', scratchDir], python: ctx.python });
      const { key, diff } = keyAndDiff(ctx, 'scratch', r);
      // testguard-locks/ is documented to stay (empty) between runs; anything else is left over.
      const left = listing(scratchDir).split('\n').filter((l) => l && !l.startsWith(':') && !/^testguard-locks(\/[^:]*)?:d:/.test(l));
      const checks = [exitCheck(r), check('scratch-dir-left-empty', left.length === 0, left.length ? left : 'empty')];
      if (ro) checks.push(check('read-only-node_modules-unchanged', listing(ro) === before, ro));
      return result('scratch', ctx.subject, { runs: [runSummary('scratch', r)], key, diff, checks });
    } finally { unlockAndRemove(root); }
  },

  /** --require-assertion-kill: same verdicts; the policy names exactly the keyed exception-only kills. */
  async 'assertion-kill'(ctx) {
    const { r } = await freshProbe(ctx, 'assertion-kill', ['--no-reuse', '--require-assertion-kill']);
    const { key, diff } = keyAndDiff(ctx, 'assertion-kill', r);
    // A keyed exception-only kill the tool did not report as a kill, under a
    // reviewed known failure, is already accounted for by that entry; the
    // policy can only name the kills the run actually produced.
    const excused = new Set((key?.mismatches ?? []).filter((m) => m.knownIssue).map((m) => m.fault));
    const want = Object.entries(expectedFor(ctx.subject, 'assertion-kill')).filter(([id, e]) => e.verdict === 'killed' && e.killKind === 'exception-only' && !excused.has(id)).map(([id]) => id).sort();
    const policy = r.json?.run?.assertionPolicy ?? r.evidence?.assertionPolicy;
    const got = (policy?.exceptionOnlyKills ?? []).map((k) => `${k.claimId}/${k.faultId}`).sort();
    const checks = [
      check('policy-names-exception-only-kills', JSON.stringify(got) === JSON.stringify(want), { expected: want, named: got }),
      check('policy-state', policy?.state === (want.length ? 'failed' : 'passed'), policy?.state ?? 'no policy recorded'),
      check('policy-fails-the-run', want.length === 0 || r.exit === 1, `exit ${r.exit}`),
    ];
    return result('assertion-kill', ctx.subject, { runs: [runSummary('assertion-kill', r)], key, diff, checks });
  },

  /** Metamorphic: claims (and the faults inside each) in reverse order. Same answers; records follow the new order. */
  async reorder(ctx) {
    let reordered;
    const { r } = await freshProbe(ctx, 'reorder', ['--no-reuse'], {
      prepare(repo) {
        const doc = JSON.parse(readFileSync(join(repo, 'claims.json'), 'utf8'));
        doc.claims = doc.claims.reverse().map((c) => ({ ...c, faults: [...c.faults].reverse() }));
        reordered = doc.claims.flatMap((c) => c.faults.map((f) => `${c.id}/${f.id}`));
        writeFileSync(join(repo, 'claims.json'), `${JSON.stringify(doc, null, 2)}\n`);
        git(repo, 'commit', '-q', '-am', 'corpus: reorder claims');
      },
    });
    const observed = verdictMap(r.evidence);
    const key = checkKey({ subject: ctx.subject, mode: 'reorder', map: observed.map, expected: expectedFor(ctx.subject, 'reorder'), known: ctx.known });
    let diff = null;
    if (ctx.reference) diff = differential({ reference: { map: ctx.reference.map, order: reordered }, observed });
    else if (ctx.deferDifferential) ctx.pending.push({ observed, referenceOrder: reordered });
    return result('reorder', ctx.subject, { runs: [runSummary('reorder', r)], key, diff, checks: [exitCheck(r)] });
  },

  /** Metamorphic: an unrelated file added and an untouched file renamed. Same answers, same order. */
  async noise(ctx) {
    const { r } = await freshProbe(ctx, 'noise', ['--no-reuse'], { edits: { edits: ctx.subject.config.noise, message: 'corpus: unrelated noise' } });
    const { key, diff } = keyAndDiff(ctx, 'noise', r);
    return result('noise', ctx.subject, { runs: [runSummary('noise', r)], key, diff, checks: [exitCheck(r)] });
  },
};

/**
 * The CLI's default width (#270): no flag, no TESTGUARD_FAULT_WORKERS, so the
 * machine decides. The answers must be the reference's, map and order, and the
 * evidence must say the width was automatic and from how many CPUs.
 */
async function defaultWidth(ctx) {
  const { r } = await freshProbe(ctx, 'default', ['--no-reuse'], { env: { TESTGUARD_FAULT_WORKERS: '' } });
  const { key, diff } = keyAndDiff(ctx, 'default', r);
  const run = r.evidence?.run ?? {};
  return result('default', ctx.subject, { runs: [runSummary('default', r)], key, diff, checks: [exitCheck(r), check('width-recorded-as-auto', run.faultWorkersSource === 'auto' && Number.isInteger(run.cpus), `faultWorkersSource ${run.faultWorkersSource}, cpus ${run.cpus}, faultWorkers ${run.faultWorkers ?? 1}`)] });
}

async function workers(ctx, n) {
  const { r } = await freshProbe(ctx, `workers-${n}`, ['--no-reuse', '--fault-workers', String(n)]);
  const { key, diff } = keyAndDiff(ctx, `workers-${n}`, r);
  return result(`workers-${n}`, ctx.subject, { runs: [runSummary(`workers-${n}`, r)], key, diff, checks: [exitCheck(r), check('fan-out-recorded', r.evidence?.run?.faultWorkers === n, `run.faultWorkers ${r.evidence?.run?.faultWorkers}`)] });
}

function mergeKey(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { total: a.total + b.total, right: a.right + b.right, wrong: a.wrong + b.wrong, critical: a.critical + b.critical, known: a.known + b.known, mismatches: [...a.mismatches, ...b.mismatches] };
}

function mergeDiff(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { equal: a.equal && b.equal, compared: a.compared + b.compared, mismatches: [...a.mismatches, ...b.mismatches], orderEqual: a.orderEqual && b.orderEqual };
}

/**
 * A copy of the tool whose only difference is its version, to simulate an
 * upgrade: evidence written by the real version must not be carried forward.
 */
function bumpedTool(ctx) {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-tool-version-'));
  for (const part of ['cli', 'src', 'spec']) cpSync(join(ctx.toolRoot, part), join(dir, part), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(ctx.toolRoot, 'package.json'), 'utf8'));
  pkg.version = `${pkg.version}-corpus.version-change`;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  if (existsSync(join(ctx.toolRoot, 'node_modules'))) symlinkSync(join(ctx.toolRoot, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}
