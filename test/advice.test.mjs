// Speed advice (issue #270): one line each, with the command, from what is
// already on disk. Informational: never a state, never a network call.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { serialAdvice, changedAdvice, reuseAdvice, costAdvice, hookAdvice, computeAdvice, renderAdvice } from '../src/status/advice.mjs';

describe('serial-on-multicore', () => {
  it('names how the last run was made serial, and the width auto would use', () => {
    const a = serialAdvice({ faultWorkersSource: 'serial' }, 8);
    expect(a).toEqual({ id: 'serial-on-multicore', message: expect.stringMatching(/with --serial on a machine with 8 CPUs; without it, 4 faults run at once/), command: 'testguard probe' });
    expect(serialAdvice({ faultWorkersSource: 'flag' }, 8).message).toMatch(/--fault-workers 1/);
    expect(serialAdvice({ faultWorkersSource: 'env' }, 8).message).toMatch(/TESTGUARD_FAULT_WORKERS=1/);
    // Evidence from before the field existed was serial whatever was asked.
    expect(serialAdvice({}, 8).message).toMatch(/one fault at a time/);
  });

  it('is silent for a fan-out, an automatic width, in place, or a machine where auto is one', () => {
    expect(serialAdvice({ faultWorkers: 4, faultWorkersSource: 'auto', cpus: 8 }, 8)).toBeUndefined();
    expect(serialAdvice({ faultWorkersSource: 'auto', cpus: 2 }, 8)).toBeUndefined();
    expect(serialAdvice({ faultWorkersSource: 'in-place' }, 8)).toBeUndefined();
    expect(serialAdvice({ faultWorkersSource: 'serial' }, 3)).toBeUndefined();
    expect(serialAdvice(undefined, 8)).toBeUndefined();
  });
});

describe('full-probe-where-changed-would-do', () => {
  it('says how many of the claims the change can affect, with the fast command', () => {
    expect(changedAdvice({ selected: 3, total: 41, ref: 'origin/main' })).toEqual({
      id: 'full-probe-where-changed-would-do',
      message: expect.stringMatching(/since origin\/main can affect 3 of 41 claims/),
      command: 'testguard probe --changed auto',
    });
  });

  it('is silent with no base, no claims, or a change that reaches every claim', () => {
    expect(changedAdvice({ selected: 3, total: 41 })).toBeUndefined();
    expect(changedAdvice({ selected: 0, total: 0, ref: 'x' })).toBeUndefined();
    expect(changedAdvice({ selected: 41, total: 41, ref: 'x' })).toBeUndefined();
  });
});

describe('nothing-reused', () => {
  it('a long run that reused nothing says to keep the evidence', () => {
    const a = reuseAdvice({ reuse: { reused: 0, measured: 120 }, measurements: { elapsedMs: 300_000 } }, 120);
    expect(a.message).toMatch(/reused no verdict and measured all 120 faults \(300s\)/);
    expect(a.message).toMatch(/in CI, cache it/);
  });

  it('a short run, a run that reused something, or one with no reuse summary says nothing', () => {
    expect(reuseAdvice({ reuse: { reused: 0, measured: 3 }, measurements: { elapsedMs: 9_000 } }, 3)).toBeUndefined();
    expect(reuseAdvice({ reuse: { reused: 2, measured: 1 }, measurements: { elapsedMs: 300_000 } }, 3)).toBeUndefined();
    expect(reuseAdvice({ measurements: { elapsedMs: 300_000 } }, 3)).toBeUndefined();
  });
});

describe('hook-outdated', () => {
  it('reports a hook that probes serially on every push and a pinned older CLI, without touching them', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-advice-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: root });
      mkdirSync(join(root, '.husky'));
      writeFileSync(join(root, '.husky/pre-push'), '#!/bin/sh\nnpx testguard probe . --confirm 3 --serial\n');
      mkdirSync(join(root, '.github/workflows'), { recursive: true });
      writeFileSync(join(root, '.github/workflows/ci.yml'), 'jobs:\n  t:\n    steps:\n      - run: npx -y testguard-cli@0.18.0 probe .\n');
      const advice = hookAdvice({ root, toolVersion: '0.23.0' });
      expect(advice.map((a) => a.message)).toEqual([
        expect.stringMatching(/^\.husky\/pre-push:2: runs probe --serial/),
        expect.stringMatching(/^\.husky\/pre-push:2: probes every claim on every push/),
        expect.stringMatching(/^\.github\/workflows\/ci\.yml:4: pins testguard-cli@0\.18\.0; 0\.23\.0 is installed here/),
      ]);
      expect(advice.every((a) => a.id === 'hook-outdated' && a.command === 'testguard init --upgrade')).toBe(true);
      // The current version and the latest tag are not stale.
      writeFileSync(join(root, '.github/workflows/ci.yml'), 'jobs:\n  t:\n    steps:\n      - run: npx -y testguard-cli@0.23.0 probe .\n      - run: npx -y testguard-cli@latest probe --changed auto\n');
      expect(hookAdvice({ root, toolVersion: '0.23.0' }).filter((a) => a.message.includes('ci.yml'))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('outside a repository there is nothing to scan', () => {
    expect(hookAdvice({ root: undefined, toolVersion: '0.23.0' })).toEqual([]);
  });
});

describe('computeAdvice', () => {
  it('orders the lines and renders each with its command', () => {
    const advice = computeAdvice({ evidence: { run: { faultWorkersSource: 'serial', reuse: { reused: 0 }, measurements: { elapsedMs: 120_000 } }, records: [{}] }, cpus: 8, changed: { selected: 1, total: 9, ref: 'origin/main' }, root: undefined, toolVersion: '0.23.0' });
    expect(advice.map((a) => a.id)).toEqual(['serial-on-multicore', 'full-probe-where-changed-would-do', 'nothing-reused']);
    expect(renderAdvice(advice)[1]).toMatch(/^speed {5}Your change since origin\/main can affect 1 of 9 claims.* → testguard probe --changed auto$/);
  });
});

describe('the status document carries the advice', () => {
  it('a project whose last probe ran with --serial is told so, with the command', async () => {
    const { computeStatus } = await import('../src/status/status.mjs');
    const { writeSpecDoc } = await import('../src/evidence/writer.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'tg-advice-status-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: dir });
      const evidence = JSON.parse((await import('node:fs')).readFileSync(new URL('../spec/conformance/examples/evidence.json', import.meta.url), 'utf8'));
      evidence.run.faultWorkersSource = 'serial';
      writeSpecDoc('evidence', join(dir, '.testguard', 'evidence.json'), evidence);
      writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify({ schemaVersion: 1, claims: [] }));
      const status = computeStatus({ projectDir: dir, toolVersion: '0.24.0', cpus: 8 });
      expect(status.advice).toEqual([expect.objectContaining({ id: 'serial-on-multicore', command: 'testguard probe' })]);
      // A selection's view gets none, and so does a caller that asked for none.
      expect(computeStatus({ projectDir: dir, toolVersion: '0.24.0', cpus: 8, advice: false }).advice).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/**
 * Evidence shaped like the field run of #291 (a shard of 54 claims; names are synthetic): two claims hold
 * half of the defender time. Runs carry only `durationMs`, as the recorded ones do.
 */
const recordsFor = (claimId, defenders, faults, runsPerFault, seconds) => Array.from({ length: faults }, (_, i) => ({
  claim: { id: claimId },
  subject: { id: `F${i + 1}` },
  defenders: { resolved: defenders },
  detail: { baselineRuns: [], probeRuns: Array.from({ length: runsPerFault }, () => ({ outcome: 'pass', durationMs: seconds * 1000 })) },
}));
const fieldShaped = () => [
  ...recordsFor('SLOW-A', ['test/a-session.test.js', 'test/b-session.test.js'], 14, 6, 73),
  ...recordsFor('SLOW-B', ['test/c-preflight.test.js'], 16, 6, 32),
  ...Array.from({ length: 52 }, (_, i) => recordsFor(`FAST-${i}`, [`test/f${i}.test.js`], 6, 6, 5)).flat(),
];

describe('slow-defenders-dominate', () => {
  it('names the few claims that hold a large share of defender time, with the file, its median per run and its run count', () => {
    const a = costAdvice({ records: fieldShaped() });
    expect(a.id).toBe('slow-defenders-dominate');
    expect(a.command).toBe('testguard claims --cost');
    expect(a.message).toMatch(/2 of 54 claims account for \d+% of defender time/);
    expect(a.message).toMatch(/SLOW-A costs 6132s: test\/[ab]-session\.test\.js takes a median 73s per run and runs 84 times/);
    expect(a.message).toMatch(/SLOW-B costs 3072s: test\/c-preflight\.test\.js takes a median 32s per run and runs 96 times/);
    expect(a.message).toMatch(/Give the claim a faster defender or split the file\./);
    expect(a.message.length).toBeLessThanOrEqual(512);
  });

  it('is silent when the data is too thin to say: few claims, little total time, no dominant claim, or fast runs', () => {
    expect(costAdvice(undefined)).toBeUndefined();
    expect(costAdvice({ records: fieldShaped().filter((r) => /SLOW|FAST-[0-9]$/.test(r.claim.id)).slice(0, 60) })).toBeUndefined(); // 12 claims
    expect(costAdvice({ records: [...recordsFor('SLOW-A', ['a.test.js'], 14, 6, 1), ...Array.from({ length: 30 }, (_, i) => recordsFor(`C${i}`, ['b.test.js'], 2, 3, 1)).flat()] })).toBeUndefined(); // under 600s
    expect(costAdvice({ records: Array.from({ length: 60 }, (_, i) => recordsFor(`EVEN-${i}`, [`t${i}.test.js`], 6, 6, 20)).flat() })).toBeUndefined(); // slow but evenly spread: no claim holds 10%
    expect(costAdvice({ records: [...recordsFor('MANY', ['m.test.js'], 40, 6, 4), ...Array.from({ length: 30 }, (_, i) => recordsFor(`C${i}`, [`c${i}.test.js`], 4, 6, 4)).flat()] })).toBeUndefined(); // big share, fast runs (< 15s): more faults, not a slow file
  });

  it('this repository\'s own evidence stays silent: its costliest claim holds 6.2% at a median under 10s', () => {
    // The thresholds were chosen from this repository's measured evidence (largest share 6.2%, largest per-run median 9.9s),
    // so the rule says nothing here and fires on the field run (largest share 34%, median 73s).
    const own = fieldShaped().map((r) => ({ ...r, detail: { ...r.detail, probeRuns: r.detail.probeRuns.map((x) => ({ ...x, durationMs: Math.min(x.durationMs, 9_900) })) } }));
    expect(costAdvice({ records: own })).toBeUndefined();
  });

  it('is part of the advice set, after nothing-reused', () => {
    const advice = computeAdvice({ evidence: { run: { faultWorkersSource: 'auto', faultWorkers: 4 }, records: fieldShaped() }, cpus: 8, root: undefined, toolVersion: '0.24.0' });
    expect(advice.map((a) => a.id)).toEqual(['slow-defenders-dominate']);
  });
});
