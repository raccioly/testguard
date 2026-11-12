/**
 * The scorecard: one JSON document (corpus/scorecard.schema.json) and a
 * rendered Markdown table. Seconds are also given normalized by the reference
 * workload of #255, timed before and after the run on the same machine, so two
 * scorecards from different runners can be compared.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { CORPUS } from './subject.mjs';
import { measureReference, WORKLOAD } from '../../.github/scripts/measure-reference.mjs';
import { completeness, resolveDeferred } from './deferred.mjs';

export const SCHEMA_PATH = join(CORPUS, 'scorecard.schema.json');

export function measureMachine() {
  const r = measureReference({ runs: 5 });
  return { workload: WORKLOAD, medianMs: r.medianMs, samplesMs: r.samplesMs.map((x) => Math.round(x)) };
}

function speedFactor(machine, toolRoot) {
  const budget = JSON.parse(readFileSync(join(toolRoot, 'testguard.cost-budget.json'), 'utf8'));
  const baselineMs = budget.reference?.baselineMs;
  if (!(baselineMs > 0) || budget.reference?.workload !== WORKLOAD) return null;
  return ((machine.before.medianMs + machine.after.medianMs) / 2) / baselineMs;
}

export function buildScorecard({ toolRoot, results, mutants, machine }) {
  const factor = speedFactor(machine, toolRoot);
  const norm = (ms) => (factor ? Math.round((ms / 1000 / factor) * 10) / 10 : null);
  let head = null;
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: toolRoot, encoding: 'utf8' }).trim(); } catch {}
  const version = JSON.parse(readFileSync(join(toolRoot, 'package.json'), 'utf8')).version;
  const refSeconds = {};
  for (const r of results) if (r.mode === 'reference') refSeconds[r.subject] = r.runs.reduce((s, x) => s + x.elapsedMs, 0);
  const rows = results.map((r) => {
    const ms = r.runs.reduce((s, x) => s + x.elapsedMs, 0);
    const inv = r.runs.every((x) => x.runnerInvocations !== null) ? r.runs.reduce((s, x) => s + x.runnerInvocations, 0) : null;
    const ref = refSeconds[r.subject];
    return {
      subject: r.subject,
      mode: r.mode,
      ok: r.ok,
      error: r.error ? String(r.error).split('\n')[0] : null,
      faults: r.key ? { total: r.key.total, right: r.key.right, wrong: r.key.wrong, critical: r.key.critical, known: r.key.known } : null,
      mismatches: r.key?.mismatches ?? [],
      differential: r.differential ? { equal: r.differential.equal, compared: r.differential.compared, orderEqual: r.differential.orderEqual, mismatches: r.differential.mismatches } : null,
      checks: r.checks.map((c) => ({ check: c.check, ok: c.ok, detail: c.detail ?? null, ...(c.critical ? { critical: true, summary: c.summary } : {}) })),
      runs: r.runs,
      runnerInvocations: inv,
      seconds: Math.round(ms / 100) / 10,
      normalizedSeconds: norm(ms),
      speedup: ref && r.mode !== 'reference' && r.runs.length === 1 ? Math.round((ref / ms) * 100) / 100 : null,
      noEvidence: r.runs.filter((x) => x.noEvidence && !x.expectNoEvidence).map((x) => ({ run: x.label, ...x.noEvidence })),
      ...(r.partial ? { partial: r.partial } : {}),
      ...(r.observed ? { observed: r.observed } : {}),
      ...(r.pending ? { pending: r.pending } : {}),
      ...(r.slice ? { slice: r.slice } : {}),
    };
  });
  const totals = rows.reduce((t, r) => {
    if (r.faults) { t.right += r.faults.right; t.wrong += r.faults.wrong; t.critical += r.faults.critical; t.known += r.faults.known; }
    t.critical += r.checks.filter((c) => c.critical && !c.ok).length;
    if (r.differential && !r.differential.equal) t.differentialMismatches++;
    t.noEvidence += r.noEvidence.length;
    return t;
  }, { right: 0, wrong: 0, critical: 0, known: 0, differentialMismatches: 0, noEvidence: 0 });
  const mutantSummary = mutants ? { total: mutants.length, caught: mutants.filter((m) => m.caught).length, results: mutants } : null;
  const ok = rows.every((r) => r.ok) && (!mutantSummary || (mutantSummary.caught === mutantSummary.total));
  return {
    schemaVersion: 1,
    tool: { version, head },
    machine: { ...machine, speedFactor: factor && Math.round(factor * 1000) / 1000 },
    ok,
    totals,
    rows,
    ...(mutantSummary ? { mutants: mutantSummary } : {}),
  };
}

/**
 * Joins scorecards from parallel shards (CI runs one per subject and per
 * mutant shard). Rows and mutants are concatenated; each shard's normalized
 * seconds stay as that shard measured them on its own runner. An empty input,
 * or two shards from different tool builds, is refused.
 */
export function mergeScorecards(docs, { subjects = null } = {}) {
  if (docs.length === 0) throw new Error('mergeScorecards: nothing to merge');
  const heads = new Set(docs.map((d) => d.tool.head));
  if (heads.size > 1) throw new Error(`mergeScorecards: shards measured different builds (${[...heads].join(', ')})`);
  // A subject split across shards by mode runs its reference in every shard
  // (the other modes compare with it). Each extra reference row is kept only
  // if it disagrees with the first one, so totals count a mode once and a
  // reference that answered differently on another runner is not hidden.
  const seen = new Map();
  const rows = [];
  for (const r of docs.flatMap((d) => d.rows)) {
    const k = `${r.subject}\u0000${r.mode}`;
    const first = seen.get(k);
    if (first && r.mode === 'reference' && first.ok === r.ok && JSON.stringify(first.mismatches) === JSON.stringify(r.mismatches)) continue;
    if (!first) seen.set(k, r);
    rows.push(r);
  }
  // Deferred comparisons, slice coverage and (under --complete) which modes have a shard (#305): judged here, never skipped.
  const judged = resolveDeferred(rows);
  const finalRows = subjects ? completeness(judged, subjects) : judged;
  rows.length = 0;
  rows.push(...finalRows);
  const mutantResults = docs.flatMap((d) => d.mutants?.results ?? []);
  const totals = rows.reduce((t, r) => {
    if (r.faults) { t.right += r.faults.right; t.wrong += r.faults.wrong; t.critical += r.faults.critical; t.known += r.faults.known; }
    t.critical += r.checks.filter((c) => c.critical && !c.ok).length;
    if (r.differential && !r.differential.equal) t.differentialMismatches++;
    t.noEvidence += (r.noEvidence ?? []).length;
    return t;
  }, { right: 0, wrong: 0, critical: 0, known: 0, differentialMismatches: 0, noEvidence: 0 });
  const factors = docs.map((d) => d.machine.speedFactor).filter((f) => f);
  const mid = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  return {
    schemaVersion: 1,
    tool: docs[0].tool,
    machine: { before: docs[0].machine.before, after: docs[docs.length - 1].machine.after, speedFactor: factors.length ? mid(factors) : null },
    ok: docs.every((d) => d.ok) && rows.every((r) => r.ok),
    totals,
    rows,
    ...(mutantResults.length || docs.some((d) => d.mutants) ? { mutants: { total: mutantResults.length, caught: mutantResults.filter((m) => m.caught).length, results: mutantResults } } : {}),
  };
}

export function validateScorecard(doc) {
  const require = createRequire(import.meta.url);
  const Ajv = require('ajv');
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
  if (!validate(doc)) throw new Error(`scorecard does not conform to ${SCHEMA_PATH}: ${ajv.errorsText(validate.errors)}`);
  return doc;
}

const cell = (x) => (x === null || x === undefined ? '–' : String(x));

export function renderMarkdown(doc, { base = null } = {}) {
  const lines = [];
  lines.push(`## Corpus scorecard — TestGuard ${doc.tool.version}${doc.tool.head ? ` @ ${doc.tool.head.slice(0, 12)}` : ''}`);
  lines.push('');
  lines.push(doc.ok ? '**All checks passed.**' : '**RED: at least one check failed.**');
  lines.push('');
  lines.push(`Totals: ${doc.totals.right} right, ${doc.totals.wrong} wrong, ${doc.totals.critical} critical, ${doc.totals.known} known (filed), ${doc.totals.differentialMismatches} differential mismatches, ${doc.totals.noEvidence ?? 0} runs where the tool wrote no evidence.${doc.machine.speedFactor ? ` Machine speed factor ${doc.machine.speedFactor} (reference workload ${doc.machine.before.medianMs.toFixed(0)} / ${doc.machine.after.medianMs.toFixed(0)} ms).` : ''}`);
  if (doc.rows.length) {
    lines.push('');
    const baseRows = new Map((base?.rows ?? []).map((r) => [`${r.subject}/${r.mode}`, r]));
    lines.push(`| subject | mode | ok | right | wrong | critical | known | differential | checks | invocations | seconds | normalized s | speedup${base ? ' | base normalized s' : ''} |`);
    lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---${base ? '|---' : ''}|`);
    for (const r of doc.rows) {
      const failed = r.checks.filter((c) => !c.ok).map((c) => c.check);
      const b = baseRows.get(`${r.subject}/${r.mode}`);
      lines.push(`| ${r.subject} | ${r.mode} | ${r.ok ? 'yes' : '**NO**'} | ${cell(r.faults?.right)} | ${cell(r.faults?.wrong)} | ${cell(r.faults?.critical)} | ${cell(r.faults?.known)} | ${r.differential ? (r.differential.equal ? 'equal' : '**mismatch**') : '–'} | ${failed.length ? `**${failed.join(', ')}**` : `${r.checks.length} ok`}${r.error ? ` error: ${r.error}` : ''} | ${cell(r.runnerInvocations)} | ${r.seconds} | ${cell(r.normalizedSeconds)} | ${cell(r.speedup)}${base ? ` | ${cell(b?.normalizedSeconds)}` : ''} |`);
    }
    const mism = doc.rows.flatMap((r) => r.mismatches.map((m) => ({ ...m, subject: r.subject, mode: r.mode })));
    if (mism.length) {
      lines.push('');
      lines.push('| subject | mode | fault | expected | observed | |');
      lines.push('|---|---|---|---|---|---|');
      const fmt = (v) => (v ? `${v.verdict}${v.reason ? ` (${v.reason})` : ''}${v.killKind ? ` [${v.killKind}]` : ''}` : 'not reported');
      for (const m of mism) lines.push(`| ${m.subject} | ${m.mode} | ${m.fault} | ${fmt(m.expected)} | ${fmt(m.observed)} | ${m.critical ? '**CRITICAL**' : m.knownIssue ? `known: #${m.knownIssue}` : '**wrong**'} |`);
    }
  }
  const modified = doc.rows.flatMap((r) => r.checks.filter((c) => c.critical && !c.ok).map((c) => ({ ...c, subject: r.subject, mode: r.mode })));
  if (modified.length) {
    lines.push('');
    lines.push('**CRITICAL: the tool modified the subject it measured**');
    lines.push('');
    for (const c of modified) lines.push(`- ${c.subject} / ${c.mode} (${c.detail?.run}): ${String(c.summary).replace(/\|/g, '\\|').slice(0, 400)}`);
  }
  const refused = doc.rows.flatMap((r) => (r.noEvidence ?? []).map((n) => ({ ...n, subject: r.subject, mode: r.mode })));
  if (refused.length) {
    lines.push('');
    lines.push('**The tool wrote no evidence** (a refusal or a crash, not a verdict):');
    lines.push('');
    lines.push('| subject | mode | run | exit | kind | reason | |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const n of refused) lines.push(`| ${n.subject} | ${n.mode} | ${n.run} | ${n.exit} | ${n.kind ?? '–'} | ${String(n.reason).replace(/\|/g, '\\|').slice(0, 200)} | ${n.knownIssue ? `known: #${n.knownIssue}` : '**unexplained**'} |`);
  }
  const knownChecks = doc.rows.flatMap((r) => r.checks.filter((c) => c.detail && c.detail.knownIssue).map((c) => ({ ...c, subject: r.subject, mode: r.mode })));
  if (knownChecks.length) {
    lines.push('');
    lines.push('| subject | mode | check | known | |');
    lines.push('|---|---|---|---|---|');
    for (const c of knownChecks) lines.push(`| ${c.subject} | ${c.mode} | ${c.check} | #${c.detail.knownIssue} | ${c.detail.noEvidence ? 'no evidence written (see above)' : c.detail.unsound ? '**UNSOUND: misses claims the change can affect**' : 'superset (imprecise, safe)'} |`);
  }
  if (doc.mutants) {
    lines.push('');
    lines.push(`### Tool mutants: ${doc.mutants.caught} of ${doc.mutants.total} caught`);
    lines.push('');
    lines.push('| mutant | caught | by |');
    lines.push('|---|---|---|');
    for (const m of doc.mutants.results) lines.push(`| ${m.name} | ${m.caught ? 'yes' : '**NO**'} | ${m.caught ? m.caughtBy : (m.error ?? 'nothing went red')} |`);
  }
  return `${lines.join('\n')}\n`;
}
