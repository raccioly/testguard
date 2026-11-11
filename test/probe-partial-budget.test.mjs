// `probe --partial-on-budget` (issue #235): when the command budget runs out
// the run writes what it proved and marks the rest not reached. Expiry is made
// deterministic with an injected clock advanced from a stage callback, never
// with a sleep, and the scratch trees are sampled at the moment it happens.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { probe } from '../src/probe/probe.mjs';
import { probeCommand } from '../src/commands/probe.mjs';
import { CommandBudget } from '../src/command-budget.mjs';
import { PreconditionError } from '../src/probe/worktree.mjs';
import { readSpecDoc } from '../src/evidence/writer.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { partialBudgetProject } from './helpers/partial-budget-project.mjs';

const LIMIT = 60_000;

/** A budget whose clock the test owns, and a hook that expires it at the n-th fault to start probing. */
function expiry(project, { startingFault, onTree }) {
  let now = 0;
  const budget = new CommandBudget(LIMIT, { now: () => now });
  const seen = new Set();
  const peak = { worktrees: 0 };
  const onStage = ({ claimId, stage }) => {
    if (stage !== 'probe' || seen.has(claimId)) return;
    seen.add(claimId);
    if (seen.size === startingFault) {
      peak.worktrees = project.worktrees();
      onTree?.();
      now = LIMIT + 1; // the deadline passes while this fault is in flight
    }
  };
  return { budget, onStage, peak };
}

const options = (project, extra) => ({
  projectDir: project.dir, claims: project.claims, runnerName: 'node-test', confirmRuns: 3, budgetMs: LIMIT, escalate: false, ...extra,
});

describe('probe --partial-on-budget', () => {
  it('a run that expires mid-run keeps the measured prefix and marks the suffix not reached', async () => {
    const project = partialBudgetProject();
    try {
      const { budget, onStage, peak } = expiry(project, { startingFault: 3 });
      const doc = await probe(options(project, { commandBudget: budget, partialOnBudget: true, onStage }));
      expect(validate('evidence', doc).errors).toEqual([]);
      expect(doc.records.map((r) => [r.claim.id, r.verdict])).toEqual([['C1', 'killed'], ['C2', 'killed'], ['C3', 'unverifiable'], ['C4', 'unverifiable']]);
      expect(doc.records.slice(2).map((r) => r.detail.reason)).toEqual(['not-reached-within-budget', 'not-reached-within-budget']);
      // The measured prefix is a full measurement: every run is there.
      expect(doc.records[0].detail.probeRuns).toHaveLength(3);
      expect(doc.run.budget).toEqual({ limitMs: LIMIT, exhausted: true, reached: 2, notReached: 2 });
      // Not vacuous: a scratch tree existed when the budget ran out, and none remains.
      expect(peak.worktrees).toBeGreaterThan(1);
      expect(project.worktrees()).toBe(1);
      expect(project.status()).toBe('');
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);

  it('under --fault-workers 3 every fault in flight is not reached and nothing half-measured is written', async () => {
    const project = partialBudgetProject();
    try {
      // The fourth fault only starts when a lane frees, so at that moment at least one fault has finished and the fourth is in flight.
      const { budget, onStage, peak } = expiry(project, { startingFault: 4 });
      const doc = await probe(options(project, { commandBudget: budget, partialOnBudget: true, faultWorkers: 3, onStage }));
      expect(validate('evidence', doc).errors).toEqual([]);
      expect(doc.records.map((r) => r.claim.id)).toEqual(['C1', 'C2', 'C3', 'C4']); // claim/fault order, whatever order they finished in
      const notReached = doc.records.filter((r) => r.detail.reason === 'not-reached-within-budget');
      expect(notReached.length).toBeGreaterThanOrEqual(1);
      expect(notReached.length).toBeLessThan(4);
      for (const record of doc.records) {
        if (record.detail.reason === 'not-reached-within-budget') expect(record.detail.probeRuns).toEqual([]);
        else { expect(record.verdict).toBe('killed'); expect(record.detail.probeRuns).toHaveLength(3); }
      }
      expect(doc.run.budget.exhausted).toBe(true);
      expect(doc.run.budget.notReached).toBe(notReached.length);
      expect(peak.worktrees).toBeGreaterThan(1);
      expect(project.worktrees()).toBe(1);
      expect(project.status()).toBe('');
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);

  it('a run that finishes inside the budget is complete and says so', async () => {
    const project = partialBudgetProject();
    try {
      const doc = await probe(options(project, { commandBudget: new CommandBudget(LIMIT), partialOnBudget: true }));
      expect(doc.run.budget).toEqual({ limitMs: LIMIT, exhausted: false, reached: 4, notReached: 0 });
      expect(validate('evidence', doc).errors).toEqual([]);
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);

  it('without the flag the budget still refuses, with today\'s message, and publishes nothing', async () => {
    const project = partialBudgetProject();
    try {
      const { budget, onStage } = expiry(project, { startingFault: 3 });
      const attempt = probe(options(project, { commandBudget: budget, onStage }));
      await expect(attempt).rejects.toThrow(PreconditionError);
      await expect(attempt).rejects.toThrow('command budget of 60000ms exhausted; no partial result was written');
      expect(project.worktrees()).toBe(1);
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);

  it('only the budget\'s own expiry becomes a document: any other failure is raised as without the flag', async () => {
    const project = partialBudgetProject();
    try {
      await expect(probe(options(project, { commandBudget: new CommandBudget(LIMIT), partialOnBudget: true, only: ['NOPE'] }))).rejects.toThrow(/unknown claim id/);
      await expect(probe(options(project, { commandBudget: new CommandBudget(LIMIT), partialOnBudget: true, ref: 'no-such-ref' }))).rejects.toThrow(/does not resolve to a commit/);
      await expect(probe(options(project, { partialOnBudget: true }))).rejects.toThrow('--partial-on-budget needs a command budget');
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);

  it('claims are probed in the caller\'s --claim order, so the caller decides what the budget buys first', async () => {
    const project = partialBudgetProject();
    try {
      const { budget, onStage } = expiry(project, { startingFault: 3 });
      const doc = await probe(options(project, { commandBudget: budget, partialOnBudget: true, onStage, only: ['C4', 'C2', 'C1', 'C3'] }));
      expect(doc.records.map((r) => [r.claim.id, r.verdict])).toEqual([['C4', 'killed'], ['C2', 'killed'], ['C1', 'unverifiable'], ['C3', 'unverifiable']]);
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);

  it('a run the budget cut short is the deadline, not a timeout verdict, even with clock left over', async () => {
    const project = partialBudgetProject({ hang: 'C2' });
    try {
      // The clock never moves: the only way the budget can end the run is by
      // capping a child's time. The child is killed at the cap and the run
      // reports it as a timeout while the clock still shows time remaining.
      const budget = new CommandBudget(2500, { now: () => 0 });
      const doc = await probe(options(project, { commandBudget: budget, partialOnBudget: true }));
      expect(doc.records.map((r) => [r.claim.id, r.verdict, r.detail.reason])).toEqual([
        ['C1', 'killed', undefined],
        ['C2', 'unverifiable', 'not-reached-within-budget'],
        ['C3', 'unverifiable', 'not-reached-within-budget'],
        ['C4', 'unverifiable', 'not-reached-within-budget'],
      ]);
      expect(project.worktrees()).toBe(1);
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);

  it('a later run does not reuse a not-reached record', async () => {
    const project = partialBudgetProject();
    try {
      const { budget, onStage } = expiry(project, { startingFault: 3 });
      const partial = await probe(options(project, { commandBudget: budget, partialOnBudget: true, onStage }));
      const later = await probe(options(project, { previous: partial, toolVersion: partial.tool.version }));
      expect(later.records.map((r) => r.verdict)).toEqual(['killed', 'killed', 'killed', 'killed']);
      expect(later.records[2].reusedFrom).toBeUndefined();
      expect(later.records[3].reusedFrom).toBeUndefined();
      expect(later.run.budget).toBeUndefined();
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);
});

describe('probe --partial-on-budget through the command', () => {
  const baseValues = { confirm: '3', budget: String(LIMIT), workers: '1', runner: 'node-test', severity: 'low', json: true, quiet: true, progress: 'none', 'no-escalate': true, 'no-reuse': true, 'command-budget': String(LIMIT), 'partial-on-budget': true };

  async function run(project, extra, startingFault, onTree) {
    const { budgetOptions, onStage, peak } = (() => {
      const e = expiry(project, { startingFault, onTree });
      return { budgetOptions: { now: e.budget.now }, onStage: e.onStage, peak: e.peak };
    })();
    const lines = []; const errs = [];
    const code = await probeCommand({ projectDir: project.dir, values: { ...baseValues, ...extra }, version: '0.0.0' }, { out: (l) => lines.push(l), err: (l) => errs.push(l) }, { budgetOptions, onStage });
    return { code, lines, errs, peak, doc: lines.length ? JSON.parse(lines.join('\n')) : undefined };
  }

  it('exits 2 and writes evidence-partial.json when the measured part holds nothing that gates', async () => {
    const project = partialBudgetProject();
    try {
      const canonical = join(project.dir, '.testguard', 'evidence.json');
      const out = await run(project, {}, 3);
      expect(out.code).toBe(2);
      expect(out.doc.run.failureKind).toBe('incomplete');
      expect(out.doc.run.unprovenAtLeast).toBeUndefined();
      expect(out.doc.run.budget).toEqual({ limitMs: LIMIT, exhausted: true, reached: 2, notReached: 2 });
      expect(out.doc.run.evidence).toBe(join(project.dir, '.testguard', 'evidence-partial.json'));
      expect(existsSync(canonical)).toBe(false);
      expect(validate('evidence', readSpecDoc('evidence', out.doc.run.evidence)).errors).toEqual([]);
      const byId = Object.fromEntries(out.doc.run.claims.map((c) => [c.id, c]));
      expect(byId.C1.result).toBe('proven');
      expect(byId.C3.result).toBe('could-not-verify');
      expect(byId.C3.reasons).toEqual([{ faultId: 'F1', verdict: 'unverifiable', reason: 'not-reached-within-budget' }]);
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);

  it('exits 1 with unproven+incomplete, and a floor, when the measured prefix already holds a survivor', async () => {
    const project = partialBudgetProject({ survivor: 'C1' });
    try {
      const out = await run(project, {}, 3);
      expect(out.code).toBe(1);
      expect(out.doc.run.failureKind).toBe('unproven+incomplete');
      expect(out.doc.run.unprovenAtLeast).toBe(1);
      expect(out.doc.run.exitCode).toBe(1);
      const byId = Object.fromEntries(out.doc.run.claims.map((c) => [c.id, c]));
      expect(byId.C1.result).toBe('unproven');
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);

  it('never overwrites the canonical evidence file, even when --out names it', async () => {
    const project = partialBudgetProject();
    try {
      const canonical = join(project.dir, '.testguard', 'evidence.json');
      const first = await run(project, { 'command-budget': undefined, 'partial-on-budget': false, out: canonical }, 99);
      expect(first.code).toBe(0);
      const before = readFileSync(canonical, 'utf8');
      const out = await run(project, { out: canonical }, 3);
      expect(out.code).toBe(2);
      expect(readFileSync(canonical, 'utf8')).toBe(before);
      expect(out.doc.run.evidence).toBe(join(project.dir, '.testguard', 'evidence-partial.json'));
      expect(out.errs.join('\n')).toContain('instead of the canonical');
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);

  it('is a usage error without --command-budget and with --require-origin', async () => {
    const project = partialBudgetProject();
    try {
      const none = await run(project, { 'command-budget': undefined }, 99);
      expect(none.code).toBe(3);
      expect(none.errs.join('\n')).toContain('--partial-on-budget needs --command-budget');
      const origin = await run(project, { 'require-origin': ['manual'] }, 99);
      expect(origin.code).toBe(3);
      expect(origin.errs.join('\n')).toContain('--require-origin');
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);

  it('without the flag the command refuses with exit 2 semantics and writes no file', async () => {
    const project = partialBudgetProject();
    try {
      const { budget, onStage } = expiry(project, { startingFault: 3 });
      await expect(probeCommand({ projectDir: project.dir, values: { ...baseValues, 'partial-on-budget': false }, version: '0.0.0' }, { out: () => {}, err: () => {} }, { budgetOptions: { now: budget.now }, onStage })).rejects.toThrow('no partial result was written');
      expect(existsSync(join(project.dir, '.testguard', 'evidence-partial.json'))).toBe(false);
      expect(existsSync(join(project.dir, '.testguard', 'evidence.json'))).toBe(false);
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);
});
