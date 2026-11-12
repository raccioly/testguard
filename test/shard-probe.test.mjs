// @req NFR-05 NFR-06
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareVerdicts, defenderSets, mergeShards, planShards, recordedCosts } from '../.github/scripts/shard-probe.mjs';
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

describe('shard-probe: claims that share a defender set land in one shard', () => {
  const withSets = { claims: [{ ...claim('A', 2), defendedBy: ['t/x.test.mjs'] }, { ...claim('B', 2), defendedBy: ['t/y.test.mjs', 't/x.test.mjs'] }, { ...claim('C', 2), defendedBy: ['t/x.test.mjs', 't/y.test.mjs'] }, { ...claim('D', 2), defendedBy: ['t/z.test.mjs'] }, { ...claim('E', 2), defendedBy: ['t/w.test.mjs'] }, { ...claim('F', 2) }] };

  it('keys a claim by its recorded resolved set, else by its own defendedBy, order-independent, and gives a claim with neither no key', () => {
    const evidence = { records: [{ claim: { id: 'A' }, defenders: { resolved: ['b.mjs', 'a.mjs'] } }, { claim: { id: 'D' }, defenders: { resolved: ['a.mjs', 'b.mjs'] } }] };
    const sets = defenderSets(withSets, evidence);
    expect(sets.get('A')).toEqual(new Set(['a.mjs\nb.mjs']));
    expect(sets.get('D')).toEqual(sets.get('A'));
    expect(sets.get('B')).toEqual(sets.get('C'));
    expect(sets.has('F')).toBe(false);
  });

  it('puts claims with an identical set together whatever the balance would prefer, and every claim once', () => {
    const sets = defenderSets(withSets);
    for (const n of [2, 3, 5]) {
      const slices = planShards(withSets, n, new Map(), sets);
      const where = (id) => slices.findIndex((s) => s.ids.includes(id));
      expect(where('B')).toBe(where('C'));
      expect(slices.flatMap((s) => s.ids).sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    }
  });

  it('joins claims that are connected through a claim using both sets, and still balances the units', () => {
    const chain = { claims: [{ ...claim('A', 1), defendedBy: ['x'] }, { ...claim('B', 1), defendedBy: ['x', 'y'] }, { ...claim('C', 1), defendedBy: ['y'] }, { ...claim('D', 1), defendedBy: ['q'] }] };
    const evidence = { records: [{ claim: { id: 'A' }, defenders: { resolved: ['x'] } }, { claim: { id: 'B' }, defenders: { resolved: ['x'] } }, { claim: { id: 'B' }, defenders: { resolved: ['y'] } }, { claim: { id: 'C' }, defenders: { resolved: ['y'] } }] };
    const slices = planShards(chain, 2, new Map(), defenderSets(chain, evidence));
    expect(slices.find((s) => s.ids.includes('A')).ids).toEqual(['A', 'B', 'C']);
    expect(slices.find((s) => s.ids.includes('D')).ids).toEqual(['D']);
  });
});

describe('shard-probe: wrong builds of the slicing are caught by the merge', () => {
  const ids = (slices) => slices.map((s) => s.ids);
  const run = (partition) => mergeShards(claimsDoc, partition.map((cs) => shardDoc(cs)));

  it('a partition that drops a claim fails the merge, naming the first lost fault', () => {
    const good = ids(planShards(claimsDoc, 3));
    expect(run(good).problems).toEqual([]);
    const dropped = good.map((cs, i) => (i === 0 ? cs.slice(1) : cs));
    const r = run(dropped);
    expect(r.doc).toBeUndefined();
    expect(r.problems.join()).toMatch(/declared fault\(s\) in no shard/);
  });

  it('a partition that gives one claim to two shards fails the merge, naming both', () => {
    const good = ids(planShards(claimsDoc, 3));
    const dup = good.map((cs, i) => (i === 1 ? [...cs, good[0][0]] : cs));
    const r = run(dup);
    expect(r.doc).toBeUndefined();
    expect(r.problems.join()).toMatch(/appears in shard 0 and shard 1/);
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

describe('check-shard-cost: the ceilings are on the sum and on the slowest shard, for this many shards', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'testguard.cost-budget.json'), 'utf8'));
  const budget = { ...cfg, sharded: { shards: 2, seconds: 1000, slowestShardSeconds: 600 } };
  const ref = (ms = budget.reference.baselineMs) => ({ workload: budget.reference.workload, medianMs: ms, cpus: budget.reference.cpus, platform: budget.reference.platform });
  const shard = (name, elapsedSeconds, over = {}) => ({ name, evidence: { records: [rec('A', 'F1', 'killed', 1000)], run: { faultWorkers: budget.faultWorkers ?? 1, measurements: { elapsedMs: elapsedSeconds * 1000 } } }, before: ref(), after: ref(), ...over });

  it('sums the shards and reports the slowest beside it', () => {
    const d = decideShardCost([shard('s0', 600), shard('s1', 400)], budget);
    expect(d.ok).toBe(true);
    expect(d.sumMs).toBe(1000000);
    expect(d.slowestMs).toBe(600000);
  });

  it('fails when the SUM is over its ceiling even though every shard alone is under it', () => {
    const d = decideShardCost([shard('s0', 520), shard('s1', 520)], budget);
    expect(d.ok).toBe(false);
    expect(d.failures.join()).toMatch(/over-budget: the shards' normalized compute/);
    expect(d.failures.join()).not.toMatch(/over-wall-budget/);
  });

  it('fails when the SLOWEST shard is over its own ceiling even though the sum is under', () => {
    const d = decideShardCost([shard('s0', 601), shard('s1', 100)], budget);
    expect(d.ok).toBe(false);
    expect(d.failures.join()).toMatch(/over-wall-budget: the slowest shard's normalized 601s is over its 600s ceiling/);
    expect(d.failures.join()).not.toMatch(/over-budget:/);
  });

  it('fails closed on another number of shards than the ceilings were derived for, in either direction', () => {
    expect(decideShardCost([shard('s0', 100)], budget).failures.join()).toMatch(/shards-mismatch: 1 shards ran, the ceilings are for 2/);
    expect(decideShardCost([shard('s0', 1), shard('s1', 1), shard('s2', 1)], budget).failures.join()).toMatch(/shards-mismatch: 3 shards ran/);
  });

  it('fails closed when the budget has no sharded configuration', () => {
    const { sharded, ...bare } = budget;
    expect(decideShardCost([shard('s0', 1)], bare).failures.join()).toMatch(/no `sharded` configuration/);
  });

  it('normalizes each shard by its own speed: a slow runner\'s shard counts for less compute', () => {
    const slow = shard('s0', 600, { before: ref(budget.reference.baselineMs * 1.5), after: ref(budget.reference.baselineMs * 1.5) });
    const d = decideShardCost([slow, shard('s1', 100)], budget);
    expect(d.rows[0].normalizedMs).toBeCloseTo(400000, -2);
  });

  it('fails closed on a shard whose reference is missing, and on one run at another fault-worker width', () => {
    const noRef = decideShardCost([shard('s0', 10, { before: undefined }), shard('s1', 10)], budget);
    expect(noRef.ok).toBe(false);
    expect(noRef.failures.join()).toMatch(/s0: reference-missing/);
    const wide = shard('s1', 10);
    wide.evidence.run.faultWorkers = (budget.faultWorkers ?? 1) + 2;
    expect(decideShardCost([shard('s0', 10), wide], budget).failures.join()).toMatch(/s1: fault-workers-mismatch/);
    expect(decideShardCost([], budget).failures).toContain('no shard evidence');
  });

  it('as a command: exits 1 with an ::error::, and prints the slowest shard\'s ceiling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-shard-cost-'));
    mkdirSync(join(dir, 'selfprobe-shard-0'), { recursive: true });
    writeFileSync(join(dir, 'selfprobe-shard-0', 'evidence.json'), JSON.stringify(shard('x', 10).evidence));
    const r = spawnSync(process.execPath, [join(ROOT, '.github', 'scripts', 'check-shard-cost.mjs'), dir], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/COST BUDGET EXCEEDED \(sharded\).*slowest shard \d+s of \d+s/);
    expect(r.stdout).toMatch(/::error::/);
    expect(spawnSync(process.execPath, [join(ROOT, '.github', 'scripts', 'check-shard-cost.mjs')], { encoding: 'utf8' }).status).toBe(2);
  });

  it('the real budget names the sharded configuration and its two ceilings', () => {
    expect(cfg.shards).toBe(1);
    expect(Number.isInteger(cfg.sharded.shards) && cfg.sharded.shards > 1).toBe(true);
    expect(cfg.sharded.seconds).toBeGreaterThan(cfg.sharded.slowestShardSeconds);
    expect(cfg.sharded.slowestShardSeconds).toBeGreaterThan(0);
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
