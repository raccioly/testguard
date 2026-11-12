// Speed advice (issue #270): one line each, with the command, from what is
// already on disk. Informational: never a state, never a network call.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { serialAdvice, changedAdvice, reuseAdvice, hookAdvice, computeAdvice, renderAdvice } from '../src/status/advice.mjs';

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
