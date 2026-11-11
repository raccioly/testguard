// The pure pieces of `probe --partial-on-budget` (issue #235). Each rule has a
// defender that needs no scratch tree and no runner.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOT_REACHED, notReachedRecord, completeRecords, budgetSummary, partialExit, isNotReached, partialEvidencePath } from '../src/probe/partial-budget.mjs';
import { isReusable } from '../src/probe/attribution.mjs';
import { claimResults } from '../src/probe/claim-results.mjs';
import { BudgetExhaustedError, CommandBudget } from '../src/command-budget.mjs';
import { PreconditionError } from '../src/probe/worktree.mjs';
import { main } from '../src/cli.mjs';
import { validate } from '../spec/lib/validate.mjs';

const claim = { id: 'C1', statement: 'C1 holds.', severity: 'high', source: { kind: 'manual', ref: 'x' }, producedBy: { producer: 'human' }, defendedBy: ['test/c1.test.mjs'] };
const fault = { id: 'F1', description: 'd', faultClass: 'return-altered', file: 'src/c1.mjs', find: '=> 1', replace: '=> 0', producedBy: { producer: 'human' } };
const inputs = { targetHash: 'a'.repeat(64), defenderHashes: {} };
const reached = (id, verdict = 'killed') => ({ claim: { id }, subject: { id: 'F1' }, verdict, detail: {} });

describe('not-reached record', () => {
  it('is unverifiable with the reason, no runs, no resolved defenders, and never claims nocover', () => {
    const r = notReachedRecord({ claim, fault, inputs, limitMs: 5000 });
    expect(r.verdict).toBe('unverifiable');
    expect(r.detail.reason).toBe(NOT_REACHED);
    expect(r.detail.baselineRuns).toEqual([]);
    expect(r.detail.probeRuns).toEqual([]);
    expect(r.defenders.resolved).toEqual([]);
    expect(r.defenders.nocover).toBe(false);
    expect(r.defenders.requested).toEqual(['test/c1.test.mjs']);
    expect(r.detail.message).toContain('5000ms');
    expect(isNotReached(r)).toBe(true);
  });

  it('a claim that discovers its defenders is marked discovered, so the document stays self-consistent', () => {
    const r = notReachedRecord({ claim: { ...claim, defendedBy: undefined }, fault, inputs, limitMs: 5000 });
    expect(r.defenders.requested).toEqual([]);
    expect(r.defenders.discovered).toBe(true);
    expect(r.defenders.selectionSource).toBe('discovery');
  });

  it('is never reusable, even when every input matches', () => {
    // Inputs that would license reuse of a measured record: if this passes
    // without the reason check, the document would let a later run skip a
    // fault nobody measured.
    const matching = { ...inputs, testUniverseHash: 'b'.repeat(64), discoveryHashes: {}, dependencyHashes: {}, dependencyClosure: 'complete' };
    const r = notReachedRecord({ claim, fault, inputs: matching, limitMs: 5000 });
    const current = { claim, inputs: matching, requested: ['test/c1.test.mjs'], resolved: [], selectionSource: 'claim', contentHash: r.subject.contentHash };
    expect(isReusable({ ...r, detail: { ...r.detail, reason: 'probe-failed-elsewhere' } }, current)).toBe(true); // the same record, with any other reason, WOULD be reusable
    expect(isReusable(r, current)).toBe(false);
  });

  it('is told apart by verdict and reason together: an unverifiable with another reason is not one', () => {
    expect(isNotReached({ verdict: 'unverifiable', detail: { reason: 'probe-error' } })).toBe(false);
    expect(isNotReached({ verdict: 'killed', detail: { reason: NOT_REACHED } })).toBe(false);
    expect(isNotReached(undefined)).toBe(false);
  });
});

describe('completeRecords', () => {
  it('keeps every settled record in claim/fault order and fills the rest, including a record settled behind an unsettled one', () => {
    const faults = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
    const settled = new Map([[0, 'A'], [2, 'C']]); // index 2 finished while 1 was in flight
    expect(completeRecords(faults, settled, (f) => `not:${f.id}`)).toEqual(['A', 'not:b', 'C', 'not:d']);
  });

  it('with nothing settled every fault is not reached', () => {
    expect(completeRecords([{ id: 'a' }, { id: 'b' }], new Map(), (f) => f.id)).toEqual(['a', 'b']);
  });
});

describe('budgetSummary', () => {
  it('derives exhausted from the records, and reached + notReached is the record count', () => {
    const nr = notReachedRecord({ claim, fault, inputs, limitMs: 1000 });
    expect(budgetSummary(1000, [{ verdict: 'killed', detail: {} }, nr, nr])).toEqual({ limitMs: 1000, exhausted: true, reached: 1, notReached: 2 });
    expect(budgetSummary(1000, [{ verdict: 'killed', detail: {} }])).toEqual({ limitMs: 1000, exhausted: false, reached: 1, notReached: 0 });
    expect(budgetSummary(1000, [])).toEqual({ limitMs: 1000, exhausted: false, reached: 0, notReached: 0 });
  });
});

describe('partialExit', () => {
  it('findings outrank incompleteness: a gating verdict in the measured part is exit 1 with a floor', () => {
    expect(partialExit({ newGating: 3 })).toEqual({ exitCode: 1, failureKind: 'unproven+incomplete', unprovenAtLeast: 3 });
  });
  it('nothing gating so far is exit 2, never 0', () => {
    expect(partialExit({ newGating: 0 })).toEqual({ exitCode: 2, failureKind: 'incomplete' });
  });
  it('a failed policy in the measured part is exit 1 without inventing an unproven count', () => {
    expect(partialExit({ newGating: 0, policyFailed: true })).toEqual({ exitCode: 1, failureKind: 'policy+incomplete' });
  });
});

describe('claim results over a partial run', () => {
  const nr = (id) => notReachedRecord({ claim: { ...claim, id }, fault, inputs, limitMs: 1000 });
  it('a claim with a not-reached fault could not be verified, and says why; a survivor beside it still makes it unproven', () => {
    const rec = (id, faultId, verdict) => ({ claim: { id }, subject: { id: faultId }, verdict, detail: {} });
    const results = claimResults([
      rec('A', 'F1', 'killed'),
      rec('B', 'F1', 'killed'), { ...nr('B'), subject: { id: 'F2' } },
      rec('C', 'F1', 'survived'), { ...nr('C'), subject: { id: 'F2' } },
    ]);
    const by = Object.fromEntries(results.map((c) => [c.id, c]));
    expect(by.A.result).toBe('proven');
    expect(by.B.result).toBe('could-not-verify');
    expect(by.B.reasons).toEqual([{ faultId: 'F2', verdict: 'unverifiable', reason: NOT_REACHED }]);
    expect(by.C.result).toBe('unproven');
  });
});

describe('budget expiry identity', () => {
  it('is a PreconditionError with today\'s message, so the default behavior is untouched', () => {
    let now = 0;
    const budget = new CommandBudget(1000, { now: () => now });
    now = 1000;
    let error;
    try { budget.assertOpen(); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect(error).toBeInstanceOf(PreconditionError);
    expect(error.message).toBe('command budget of 1000ms exhausted; no partial result was written');
  });

  it('a run the budget cut short is the deadline, not a timeout verdict, even with a sliver of clock left', () => {
    const budget = new CommandBudget(1000, { now: () => 0 });
    expect(() => budget.assertNotCut(400, 120_000, 1)).toThrow(BudgetExhaustedError);
    expect(() => budget.assertNotCut(120_000, 120_000, 1)).not.toThrow(); // a real per-run timeout stays a verdict
    expect(() => budget.assertNotCut(400, 120_000, 0)).not.toThrow(); // cut short but finished: nothing to refuse
  });

  it('the partial document never lands on the canonical evidence file', () => {
    expect(partialEvidencePath('/p')).toBe(join('/p', '.testguard', 'evidence-partial.json'));
  });
});

describe('the flag at the CLI boundary', () => {
  const run = async (args) => {
    const lines = [];
    const code = await main(args, { out: (l) => lines.push(l), err: (l) => lines.push(l) });
    return { code, text: lines.join('\n') };
  };

  it('sweep, replay and admit refuse the flag instead of ignoring it', async () => {
    for (const args of [['sweep', '.'], ['replay', '.', '--since', 'HEAD~1..HEAD'], ['admit', '.']]) {
      const { code, text } = await run([...args, '--command-budget', '5000', '--partial-on-budget']);
      expect(code).toBe(3);
      expect(text).toContain('--partial-on-budget is only valid on probe');
    }
  });

  it('probe without --command-budget is a usage error', async () => {
    const { code, text } = await run(['probe', '.', '--partial-on-budget']);
    expect(code).toBe(3);
    expect(text).toContain('--partial-on-budget needs --command-budget');
  });

  it('baseline refuses an exhausted document, as it refuses a provisional one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-partial-baseline-'));
    try {
      const example = join(process.cwd(), 'spec', 'conformance', 'examples', 'evidence-partial-budget.json');
      expect(validate('evidence', JSON.parse(readFileSync(example, 'utf8'))).ok).toBe(true);
      const { code, text } = await run(['baseline', dir, '--evidence', example]);
      expect(code).toBe(2);
      expect(text).toContain('A baseline is never frozen from it');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
