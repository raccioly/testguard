#!/usr/bin/env node
/**
 * Shard the full self-probe across CI jobs, and put the result back together
 * without changing a verdict.
 *
 *   plan    --shards <n> --claims <file> [--weights-from <evidence.json>]
 *             Assigns every claim to exactly one shard, balanced by recorded cost
 *             (the last main evidence) when there is one, else by fault count.
 *             Deterministic. Writes `shards=<json array of comma-joined claim ids>`
 *             to $GITHUB_OUTPUT and prints the balance. Computed ONCE, in one job,
 *             so every shard works from the same partition.
 *   merge   --dir <dir> --claims <file> --out <file>
 *             Reads <dir>/<shard>/evidence.json, requires every fault of every claim to
 *             appear exactly once across them (a missing, duplicated or unknown
 *             fault fails), and writes ONE evidence document in the claims file's order.
 *   compare <a.json> <b.json>
 *             The two evidence documents must give the same verdict for every
 *             claim/fault they share; exit 1 otherwise.
 */
import { existsSync, readdirSync, readFileSync, statSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordedOriginSummary } from '../../spec/lib/origins.mjs';
import { parseArgs } from 'node:util';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const key = (claimId, faultId) => `${claimId}/${faultId}`;

/** Claim id -> cost in ms from an evidence document: the sum of every run its records paid for. */
export function recordedCosts(evidence) {
  const costs = new Map();
  for (const r of evidence?.records ?? []) {
    const runs = [...(r.detail?.baselineRuns ?? []), ...(r.detail?.probeRuns ?? []), ...(r.detail?.escalationRuns ?? [])];
    costs.set(r.claim?.id, (costs.get(r.claim?.id) ?? 0) + runs.reduce((a, x) => a + (x.durationMs ?? 0), 0));
  }
  return costs;
}

/**
 * Longest-processing-time-first: heaviest claim to the lightest shard. A claim
 * with no recorded cost is weighted by its fault count at the average cost per
 * fault of those that have one (or by fault count alone with no recording).
 * Ties break by claim id, so the partition is a pure function of its inputs.
 */
export function planShards(claimsDoc, shards, costs = new Map()) {
  if (!Number.isInteger(shards) || shards < 1) throw new RangeError('shards must be a positive integer');
  const claims = claimsDoc.claims ?? [];
  const known = claims.filter((c) => costs.has(c.id));
  const faultsKnown = known.reduce((a, c) => a + c.faults.length, 0);
  const perFault = faultsKnown > 0 ? known.reduce((a, c) => a + costs.get(c.id), 0) / faultsKnown : 1;
  const weight = (c) => (costs.has(c.id) ? costs.get(c.id) : c.faults.length * perFault);
  const order = [...claims].sort((a, b) => weight(b) - weight(a) || (a.id < b.id ? -1 : 1));
  const slices = Array.from({ length: shards }, () => ({ ids: [], weight: 0, faults: 0 }));
  for (const c of order) {
    const lightest = slices.reduce((m, s, i) => (s.weight < slices[m].weight ? i : m), 0);
    slices[lightest].ids.push(c.id);
    slices[lightest].weight += weight(c);
    slices[lightest].faults += c.faults.length;
  }
  return slices.map((s) => ({ ...s, ids: s.ids.sort() }));
}

const SUMMED = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a + b : a ?? b);

/**
 * One evidence document from the shards'. Returns `{ doc, problems }`; a document
 * is returned only when there are no problems. Every declared fault appears
 * exactly once, none that the claims do not declare, and the shards probed one
 * commit. `run.measurements` is summed: the merged `elapsedMs` is total compute,
 * which is what the cost ceiling is on.
 */
export function mergeShards(claimsDoc, shardDocs) {
  const problems = [];
  const declared = [];
  for (const c of claimsDoc.claims ?? []) for (const f of c.faults ?? []) declared.push(key(c.id, f.id));
  const seen = new Map();
  for (const [i, doc] of shardDocs.entries()) {
    for (const r of doc.records ?? []) {
      const k = key(r.claim?.id, r.subject?.id);
      if (seen.has(k)) problems.push(`${k} appears in shard ${seen.get(k).shard} and shard ${i}`);
      else seen.set(k, { shard: i, record: r });
    }
  }
  const want = new Set(declared);
  const missing = declared.filter((k) => !seen.has(k));
  const extra = [...seen.keys()].filter((k) => !want.has(k));
  if (missing.length) problems.push(`${missing.length} declared fault(s) in no shard, first: ${missing[0]}`);
  if (extra.length) problems.push(`${extra.length} fault(s) the claims do not declare, first: ${extra[0]}`);
  const heads = new Set(shardDocs.map((d) => d.run?.repo?.head));
  if (heads.size > 1) problems.push(`the shards probed different commits: ${[...heads].join(', ')}`);
  for (const [i, d] of shardDocs.entries()) {
    if (d.run?.provisional === true) problems.push(`shard ${i} is provisional`);
    if (d.run?.budget?.exhausted === true) problems.push(`shard ${i} ran out of its command budget`);
  }
  if (shardDocs.length === 0) problems.push('no shard evidence');
  if (problems.length) return { problems };
  const first = shardDocs[0];
  const measurements = {};
  for (const d of shardDocs) for (const [k, v] of Object.entries(d.run?.measurements ?? {})) measurements[k] = SUMMED(measurements[k], v);
  const reuse = shardDocs.reduce((a, d) => ({ reused: a.reused + (d.run?.reuse?.reused ?? 0), measured: a.measured + (d.run?.reuse?.measured ?? 0) }), { reused: 0, measured: 0 });
  const records = declared.map((k) => seen.get(k).record);
  const starts = shardDocs.map((d) => d.run?.startedAt).filter(Boolean).sort();
  const ends = shardDocs.map((d) => d.run?.finishedAt).filter(Boolean).sort();
  const run = { ...first.run, startedAt: starts[0], ...(ends.length ? { finishedAt: ends[ends.length - 1] } : {}), measurements, ...(first.run?.reuse ? { reuse } : {}) };
  // `origins` summarizes the records and the validator recomputes it from them.
  return { problems, doc: { ...first, run, records, origins: recordedOriginSummary(records) } };
}

/** Verdicts the two documents disagree on, over the faults both carry. */
export function compareVerdicts(a, b) {
  const map = (d) => new Map((d.records ?? []).map((r) => [key(r.claim?.id, r.subject?.id), r.verdict]));
  const ma = map(a);
  const mb = map(b);
  const shared = [...ma.keys()].filter((k) => mb.has(k));
  return { shared: shared.length, onlyA: ma.size - shared.length, onlyB: mb.size - shared.length, differ: shared.filter((k) => ma.get(k) !== mb.get(k)).map((k) => `${k}: ${ma.get(k)} vs ${mb.get(k)}`) };
}

/** `<dir>/<shard>/evidence.json` for every shard directory, in name order. */
export function shardEvidencePaths(dir) {
  return readdirSync(dir).sort().map((n) => join(dir, n)).filter((p) => statSync(p).isDirectory() && existsSync(join(p, 'evidence.json'))).map((p) => join(p, 'evidence.json'));
}

export async function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { shards: { type: 'string' }, claims: { type: 'string', default: 'testguard.claims.json' }, 'weights-from': { type: 'string' }, dir: { type: 'string' }, out: { type: 'string' } } });
  if (command === 'plan') {
    const n = Number(values.shards);
    if (!Number.isInteger(n) || n < 1) { console.error('usage: shard-probe.mjs plan --shards <n> [--claims <file>] [--weights-from <evidence>]'); return 2; }
    let costs = new Map();
    let basis = 'fault count';
    if (values['weights-from'] && existsSync(values['weights-from'])) {
      try { costs = recordedCosts(readJson(values['weights-from'])); basis = `recorded cost of ${costs.size} claims`; } catch { costs = new Map(); }
    }
    const claimsDoc = readJson(resolve(values.claims));
    const slices = planShards(claimsDoc, n, costs);
    console.log(`shard plan (${basis}): ${slices.map((s, i) => `#${i} ${s.ids.length} claims/${s.faults} faults/${Math.round(s.weight / 1000)}s`).join('; ')}`);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `shards=${JSON.stringify(slices.map((s) => s.ids.join(',')))}\n`);
    return 0;
  }
  if (command === 'merge') {
    if (!values.dir || !values.out) { console.error('usage: shard-probe.mjs merge --dir <dir> --out <file> [--claims <file>]'); return 2; }
    const docs = shardEvidencePaths(resolve(values.dir)).map(readJson);
    const { problems, doc } = mergeShards(readJson(resolve(values.claims)), docs);
    if (problems.length) {
      for (const p of problems) console.error(`::error::sharded probe not merged: ${p}`);
      return 1;
    }
    const { writeSpecDoc } = await import('../../src/evidence/writer.mjs');
    writeSpecDoc('evidence', resolve(values.out), doc);
    console.log(`merged ${docs.length} shards into ${values.out}: ${doc.records.length} faults, each exactly once`);
    return 0;
  }
  if (command === 'compare') {
    const [a, b] = positionals;
    if (!a || !b) { console.error('usage: shard-probe.mjs compare <a.json> <b.json>'); return 2; }
    const r = compareVerdicts(readJson(a), readJson(b));
    console.log(`verdicts: ${r.shared} shared, ${r.onlyA} only in the first, ${r.onlyB} only in the second, ${r.differ.length} differ`);
    for (const d of r.differ) console.error(`::error::${d}`);
    return r.differ.length || r.shared === 0 ? 1 : 0;
  }
  console.error('usage: shard-probe.mjs plan|merge|compare ...');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main(process.argv.slice(2)));
