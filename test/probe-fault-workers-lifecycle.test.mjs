// A fan-out leaves no scratch tree behind, interrupted or not, and two probes
// on one repository share its worktree registry safely (issue #237).
import { it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fanOutProject } from './helpers/fan-out-project.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'testguard.mjs');

const scratchTrees = (dir) => spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout
  .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length)).slice(1);

function cli(args, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.resume();
  const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stderr })));
  return { child, done };
}

it('SIGINT in the middle of a fan-out exits 130 and leaves no scratch worktree', async () => {
  const project = fanOutProject();
  try {
    // With the markers set, the SLOW defender hangs while the others run, so
    // the fan-out is reliably still in flight when the signal arrives.
    const { child, done } = cli(['probe', project.dir, '--runner', 'node-test', '--fault-workers', '3', '--budget', '20000', '--no-escalate', '--quiet', '--out', join(project.markers, 'evidence.json')], { TG_FANOUT_MARKERS: project.markers });
    let during = [];
    let exited = false;
    done.then(() => { exited = true; });
    const deadline = Date.now() + 30_000;
    // Stop polling as soon as the probe is gone: a build that never fans out
    // must fail here in seconds, not after the deadline.
    while (during.length < 3 && !exited && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      during = scratchTrees(project.dir);
    }
    // Not vacuous: the trees existed while the run was interrupted.
    expect(during.length).toBe(3);
    child.kill('SIGINT');
    const { code } = await done;
    expect(code).toBe(130);
    expect(scratchTrees(project.dir)).toEqual([]);
    for (const tree of during) expect(existsSync(tree)).toBe(false);
  } finally {
    rmSync(project.dir, { recursive: true, force: true });
    rmSync(project.markers, { recursive: true, force: true });
  }
}, 60_000);

it('two concurrent fan-out probes on one repository both finish with the right verdicts', async () => {
  const project = fanOutProject();
  const out = mkdtempSync(join(tmpdir(), 'tg-fanout-out-'));
  try {
    const runs = [0, 1].map((i) => cli(['probe', project.dir, '--runner', 'node-test', '--fault-workers', '2', '--no-escalate', '--quiet', '--out', join(out, `${i}.json`)]));
    const results = await Promise.all(runs.map((run) => run.done));
    for (const [i, result] of results.entries()) {
      // QUIET survives and MISSING cannot be probed: unproven, so exit 1, not 2 or 3.
      expect(result.code, result.stderr).toBe(1);
      const evidence = JSON.parse(readFileSync(join(out, `${i}.json`), 'utf8'));
      expect(evidence.records.map((r) => `${r.claim.id}:${r.verdict}`)).toEqual(['FAST:killed', 'MISSING:unverifiable', 'QUIET:survived', 'SLOW:killed']);
      expect(evidence.run.faultWorkers).toBe(2);
    }
    expect(scratchTrees(project.dir)).toEqual([]);
  } finally {
    rmSync(project.dir, { recursive: true, force: true });
    rmSync(project.markers, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
