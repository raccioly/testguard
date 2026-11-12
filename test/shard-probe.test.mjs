// @req NFR-05 NFR-06
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareVerdicts, mergeShards, planShards, recordedCosts } from '../.github/scripts/shard-probe.mjs';
import { recordedOriginSummary } from '../spec/lib/origins.mjs';
import { decideShardCost } from '../.github/scripts/check-shard-cost.mjs';
import { changedClaimIds, decideScope } from '../.github/scripts/self-probe-scope.mjs';
import { ROOT } from './helpers/release-project.mjs';

const claim = (id, n) => ({ id, faults: Array.from({ length: n }, (_, i) => ({ id: `F${i + 1}` })) });
const claimsDoc = { claims: [claim('A', 3), claim('B', 1), claim('C', 2), claim('D', 4), claim('E', 1)] };
const rec = (c, f, verdict = 'killed', ms = 1000) => ({ claim: { id: c, source: { kind: 'manual' } }, subject: { id: f }, verdict, detail: { baselineRuns: [], probeRuns: [{ durationMs: ms }] } });
const recordsFor = (ids) => claimsDoc.claims.filter((c) => ids.includes(c.id)).flatMap((c) => c.faults.map((f) => rec(c.id, f.id)));
const shardDoc = (ids, over = {}) => ({ schemaVersion: 1, run: { startedAt: '2026-11-12T10:00:00.000Z', finishedAt: '2026-11-12T10:10:00.000Z', repo: { head: 'a'.repeat(40) }, measurements: { elapsedMs: 100, runnerInvocations: 4 }, reuse: { reused: 0, measured: ids.length }, ...over.run }, records: recordsFor(ids), ...over.top });

describe('shard-probe: every claim lands in exactly one shard, deterministically', () => {
  it('assigns each claim once, whatever the shard count', () => {
    for (const n of [1, 2, 3, 5, 9]) {
      const slices = planShards(claimsDoc, n);
      expect(slices).toHaveLength(n);
      expect(slices.flatMap((s) => s.ids).sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
    }
  });

  it('balances by fault count with no recording and by recorded cost with one', () => {
    const byFaults = planShards(claimsDoc, 2);
    expect(byFaults.map((s) => s.faults).sort()).toEqual([5, 6]);
    const costs = new Map([['A', 90000], ['B', 10000], ['C', 10000], ['D', 10000], ['E', 10000]]);
    const byCost = planShards(claimsDoc, 2, costs);
    expect(byCost.find((s) => s.ids.includes('A')).ids).toEqual(['A']);
  });

  it('weights a claim with no recording by its fault count at the average cost of those that have one', () => {
    const slices = planShards(claimsDoc, 2, new Map([['B', 1000]]));
    expect(slices.flatMap((s) => s.ids).sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(slices.find((s) => s.ids.includes('D')).weight).toBeGreaterThanOrEqual(4000);
  });

  it('is a pure function of its inputs: the same plan every time, ties broken by id', () => {
    expect(planShards(claimsDoc, 3)).toEqual(planShards(claimsDoc, 3));
    const equal = { claims: [claim('Z', 1), claim('M', 1), claim('A', 1), claim('Q', 1)] };
    expect(planShards(equal, 2).map((s) => s.ids)).toEqual([['A', 'Q'], ['M', 'Z']]);
  });

  it('refuses a shard count that is not a positive integer', () => {
    for (const n of [0, -1, 1.5, '2', undefined]) expect(() => planShards(claimsDoc, n)).toThrow(RangeError);
  });

  it('reads a claim\'s cost as the sum of every run its records paid for', () => {
    const costs = recordedCosts({ records: [rec('A', 'F1', 'killed', 100), rec('A', 'F2', 'killed', 50), { claim: { id: 'B' }, subject: { id: 'F1' }, detail: { baselineRuns: [{ durationMs: 7 }], probeRuns: [{ durationMs: 1 }], escalationRuns: [{ durationMs: 2 }] } }] });
    expect(costs.get('A')).toBe(150);
    expect(costs.get('B')).toBe(10);
  });
});

describe('shard-probe: the merge fails unless every fault appears exactly once', () => {
  const slices = [['A', 'B'], ['C'], ['D', 'E']];

  it('merges complete shards into one document in the claims file\'s order, summing total compute', () => {
    const { problems, doc } = mergeShards(claimsDoc, [shardDoc(['D', 'E']), shardDoc(['A', 'B']), shardDoc(['C'])]);
    expect(problems).toEqual([]);
    expect(doc.records.map((r) => `${r.claim.id}/${r.subject.id}`)).toEqual(claimsDoc.claims.flatMap((c) => c.faults.map((f) => `${c.id}/${f.id}`)));
    expect(doc.run.measurements).toEqual({ elapsedMs: 300, runnerInvocations: 12 });
    expect(doc.run.reuse).toEqual({ reused: 0, measured: 5 });
    expect(doc.run.startedAt).toBe('2026-11-12T10:00:00.000Z');
    expect(doc.origins).toEqual(recordedOriginSummary(doc.records));
  });

  it('fails on a fault in no shard (a lost shard must not read as a smaller passing probe)', () => {
    const r = mergeShards(claimsDoc, [shardDoc(slices[0]), shardDoc(slices[1])]);
    expect(r.doc).toBeUndefined();
    expect(r.problems.join()).toMatch(/5 declared fault\(s\) in no shard, first: D\/F1/);
  });

  it('fails on a fault in two shards, naming both', () => {
    const r = mergeShards(claimsDoc, [shardDoc(['A', 'B', 'C']), shardDoc(['C', 'D', 'E'])]);
    expect(r.doc).toBeUndefined();
    expect(r.problems.join()).toMatch(/C\/F1 appears in shard 0 and shard 1/);
  });

  it('fails on a fault the claims do not declare', () => {
    const extra = shardDoc(['A', 'B', 'C', 'D', 'E']);
    extra.records.push(rec('X', 'F1'));
    expect(mergeShards(claimsDoc, [extra]).problems.join()).toMatch(/1 fault\(s\) the claims do not declare, first: X\/F1/);
  });

  it('fails when the shards probed different commits, or one was provisional or out of budget, or there are none', () => {
    const other = shardDoc(['C'], { run: { repo: { head: 'b'.repeat(40) } } });
    expect(mergeShards(claimsDoc, [shardDoc(['A', 'B']), other, shardDoc(['D', 'E'])]).problems.join()).toMatch(/different commits/);
    expect(mergeShards(claimsDoc, [shardDoc(['A', 'B', 'C', 'D', 'E'], { run: { provisional: true } })]).problems.join()).toMatch(/shard 0 is provisional/);
    expect(mergeShards(claimsDoc, [shardDoc(['A', 'B', 'C', 'D', 'E'], { run: { budget: { exhausted: true } } })]).problems.join()).toMatch(/ran out of its command budget/);
    expect(mergeShards(claimsDoc, []).problems.join()).toMatch(/no shard evidence/);
  });

  it('keeps a verdict as the shard measured it: sharding changes no verdict', () => {
    const survivor = shardDoc(['A', 'B']);
    survivor.records[0].verdict = 'survived';
    const { doc } = mergeShards(claimsDoc, [survivor, shardDoc(['C']), shardDoc(['D', 'E'])]);
    expect(doc.records.find((r) => r.claim.id === 'A' && r.subject.id === 'F1').verdict).toBe('survived');
    expect(doc.records.filter((r) => r.verdict === 'survived')).toHaveLength(1);
  });
});

describe('shard-probe: comparing a sharded run with an unsharded one', () => {
  const doc = (verdicts) => ({ records: Object.entries(verdicts).map(([k, v]) => rec(...k.split('/'), v)) });

  it('counts what is shared and lists every disagreement', () => {
    const r = compareVerdicts(doc({ 'A/F1': 'killed', 'A/F2': 'killed', 'B/F1': 'killed' }), doc({ 'A/F1': 'killed', 'A/F2': 'survived', 'C/F1': 'killed' }));
    expect(r).toEqual({ shared: 2, onlyA: 1, onlyB: 1, differ: ['A/F2: killed vs survived'] });
  });
});

describe('shard-probe as a command', () => {
  const script = join(ROOT, '.github', 'scripts', 'shard-probe.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'tg-shard-'));
  const claims = join(dir, 'claims.json');
  writeFileSync(claims, JSON.stringify(claimsDoc));
  const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', ...env } });

  it('plan prints the balance and writes the partition to GITHUB_OUTPUT as one JSON array of comma-joined ids', () => {
    const out = join(dir, 'out.txt');
    writeFileSync(out, '');
    const r = run(['plan', '--shards', '2', '--claims', claims], { GITHUB_OUTPUT: out });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/shard plan \(fault count\): #0 \d claims\/\d faults/);
    const line = readFileSync(out, 'utf8').trim();
    const shards = JSON.parse(line.replace(/^shards=/, ''));
    expect(shards).toHaveLength(2);
    expect(shards.join(',').split(',').sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(run(['plan', '--shards', '0', '--claims', claims]).status).toBe(2);
    expect(run(['bogus']).status).toBe(2);
  });

  it('compare exits 1 on a disagreement and when nothing is shared, 0 when verdicts agree', () => {
    const write = (name, verdict) => { const p = join(dir, name); writeFileSync(p, JSON.stringify({ records: [rec('A', 'F1', verdict)] })); return p; };
    expect(run(['compare', write('x.json', 'killed'), write('y.json', 'killed')]).status).toBe(0);
    const bad = run(['compare', write('x.json', 'killed'), write('z.json', 'survived')]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('A/F1: killed vs survived');
    const none = join(dir, 'none.json');
    writeFileSync(none, JSON.stringify({ records: [rec('Q', 'F1')] }));
    expect(run(['compare', write('x.json', 'killed'), none]).status).toBe(1);
  });

  it('merge refuses an incomplete set of shard directories with an ::error:: and writes nothing', () => {
    const shards = join(dir, 'shards');
    mkdirSync(join(shards, 'selfprobe-shard-0'), { recursive: true });
    writeFileSync(join(shards, 'selfprobe-shard-0', 'evidence.json'), JSON.stringify(shardDoc(['A', 'B'])));
    const out = join(dir, 'merged.json');
    const r = run(['merge', '--dir', shards, '--claims', claims, '--out', out]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error::sharded probe not merged: .*in no shard/);
    expect(() => readFileSync(out)).toThrow();
  });
});

describe('check-shard-cost: the ceiling is on the sum of the shards\' normalized compute', () => {
  const budget = JSON.parse(readFileSync(join(ROOT, 'testguard.cost-budget.json'), 'utf8'));
  const ref = (ms = budget.reference.baselineMs) => ({ workload: budget.reference.workload, medianMs: ms, cpus: budget.reference.cpus, platform: budget.reference.platform });
  const shard = (name, elapsedSeconds, over = {}) => ({ name, evidence: { records: [rec('A', 'F1', 'killed', 1000)], run: { faultWorkers: budget.faultWorkers ?? 1, measurements: { elapsedMs: elapsedSeconds * 1000 } } }, before: ref(), after: ref(), ...over });

  it('sums the shards and reports the slowest beside it, so the ceiling does not depend on the shard count', () => {
    const d = decideShardCost([shard('s0', 600), shard('s1', 500), shard('s2', 400), shard('s3', 300)], budget);
    expect(d.ok).toBe(true);
    expect(d.sumMs).toBe(1800000);
    expect(d.slowestMs).toBe(600000);
    const same = decideShardCost([shard('s0', 1800)], budget);
    expect(same.sumMs).toBe(d.sumMs);
  });

  it('fails when the SUM is over the ceiling even though every shard alone is under it', () => {
    const each = budget.seconds / 3 + 1;
    const d = decideShardCost([shard('s0', each), shard('s1', each), shard('s2', each)], budget);
    expect(d.ok).toBe(false);
    expect(d.failures.join()).toMatch(/over-budget: the shards' normalized compute/);
  });

  it('normalizes each shard by its own speed: a slow runner\'s shard counts for less compute', () => {
    const slow = shard('s0', 1000, { before: ref(budget.reference.baselineMs * 1.5), after: ref(budget.reference.baselineMs * 1.5) });
    const d = decideShardCost([slow], budget);
    expect(d.rows[0].normalizedMs).toBeCloseTo(1000000 / 1.5, -2);
  });

  it('fails closed on a shard whose reference is missing, and on one run at another fault-worker width', () => {
    const noRef = decideShardCost([shard('s0', 10, { before: undefined })], budget);
    expect(noRef.ok).toBe(false);
    expect(noRef.failures.join()).toMatch(/s0: reference-missing/);
    const wide = shard('s1', 10);
    wide.evidence.run.faultWorkers = (budget.faultWorkers ?? 1) + 2;
    expect(decideShardCost([wide], budget).failures.join()).toMatch(/s1: fault-workers-mismatch/);
    expect(decideShardCost([], budget).failures).toContain('no shard evidence');
  });

  it('as a command: exits 1 with an ::error:: when a shard is missing its reference', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-shard-cost-'));
    mkdirSync(join(dir, 'selfprobe-shard-0'), { recursive: true });
    writeFileSync(join(dir, 'selfprobe-shard-0', 'evidence.json'), JSON.stringify(shard('x', 10).evidence));
    const r = spawnSync(process.execPath, [join(ROOT, '.github', 'scripts', 'check-shard-cost.mjs'), dir], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/COST BUDGET EXCEEDED \(sharded\)/);
    expect(r.stdout).toMatch(/::error::/);
    expect(spawnSync(process.execPath, [join(ROOT, '.github', 'scripts', 'check-shard-cost.mjs')], { encoding: 'utf8' }).status).toBe(2);
  });
});

describe('self-probe-scope: a claims-file change probes the claims whose entry changed', () => {
  const base = { claims: [{ id: 'A', statement: 's', severity: 'high', defendedBy: ['t1'], faults: [{ id: 'F1', find: 'x' }] }, { id: 'B', statement: 'b', faults: [] }, { id: 'GONE', faults: [] }] };
  const head = (mutate) => { const h = JSON.parse(JSON.stringify(base)); mutate(h); return h; };

  it('names an added claim and a claim changed in any field, and ignores key order and untouched claims', () => {
    expect(changedClaimIds(base, head((h) => h.claims.push({ id: 'NEW', faults: [] })))).toEqual(['NEW']);
    for (const mutate of [
      (h) => { h.claims[0].statement = 'changed'; }, (h) => { h.claims[0].severity = 'low'; }, (h) => { h.claims[0].defendedBy.push('t2'); },
      (h) => { h.claims[0].faults[0].find = 'y'; }, (h) => { h.claims[0].faults.push({ id: 'F2' }); }, (h) => { h.claims[0].source = { kind: 'manual' }; },
    ]) expect(changedClaimIds(base, head(mutate))).toEqual(['A']);
    expect(changedClaimIds(base, head((h) => { h.claims[0] = Object.fromEntries(Object.entries(h.claims[0]).reverse()); }))).toEqual([]);
  });

  it('a removed claim selects nothing', () => {
    expect(changedClaimIds(base, head((h) => { h.claims = h.claims.filter((c) => c.id !== 'GONE'); }))).toEqual([]);
  });

  it('a pull request that changes the claims file is scoped, to those claims, not full', () => {
    const d = decideScope({ event: 'pull_request', headRef: 'feature/x', changedFiles: ['testguard.claims.json', 'test/a.test.mjs'], claimIds: ['A', 'NEW'] });
    expect(d.mode).toBe('scoped');
    expect(d.claimIds).toEqual(['A', 'NEW']);
    expect(d.reasons.join()).toContain('A, NEW');
  });

  it('is full when the changed claims could not be determined, and never narrows a change to the file the claims do not touch', () => {
    expect(decideScope({ event: 'pull_request', headRef: 'feature/x', changedFiles: ['testguard.claims.json'], claimIds: undefined }).mode).toBe('full');
    expect(decideScope({ event: 'pull_request', headRef: 'feature/x', changedFiles: ['README.md'] }).claimIds).toEqual([]);
  });

  it('as a command: parses both versions of the file and prints and outputs the changed ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-scope-claims-'));
    const files = join(dir, 'files.txt');
    writeFileSync(files, 'testguard.claims.json\n');
    const baseFile = join(dir, 'base.json');
    writeFileSync(baseFile, JSON.stringify(base));
    const out = join(dir, 'out.txt');
    writeFileSync(out, '');
    // The command reads the head claims from the working directory.
    writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(head((h) => { h.claims[1].statement = 'edited'; })));
    const r = spawnSync(process.execPath, [join(ROOT, '.github/scripts/self-probe-scope.mjs'), '--event', 'pull_request', '--head-ref', 'feature/x', '--files-from', files, '--base-claims-file', baseFile], { encoding: 'utf8', cwd: dir, env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: '' } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('changed 1 claim(s): B');
    expect(readFileSync(out, 'utf8')).toBe('mode=scoped\nclaim_ids=B\n');
  });
});
