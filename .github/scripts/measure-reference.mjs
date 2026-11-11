#!/usr/bin/env node
/**
 * The reference workload the cost gate normalizes by (issue #255).
 *
 * A probe run is a test-runner process started on a small project, over and
 * over. This does the same on a tiny fixed project: it starts `node --test`
 * on one file that loads modules, burns CPU and touches the filesystem, several
 * times, and reports the MEDIAN wall time. CI runs it immediately before and
 * immediately after the self-probe, in the same job, so what it measures is the
 * speed of the machine the probe actually ran on. Nothing here touches the
 * network or the repository under test.
 *
 * The medians are only ever used as a ratio against the baseline recorded in
 * `testguard.cost-budget.json`, so the absolute numbers mean nothing. If this
 * file's workload changes, `WORKLOAD` changes with it and the baseline must be
 * re-taken: a measurement of another workload is refused, not compared.
 *
 * usage: measure-reference.mjs --out <file> [--runs 9]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { median } from '../../src/probe/cost.mjs';

/** Names the workload below; the baseline in the budget file is only valid for this exact name. */
export const WORKLOAD = 'node-test-spawn-v1';

const TEST_SOURCE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

test('reference workload', () => {
  let x = 0;
  for (let i = 0; i < 4e7; i++) x = (x + i) % 9973;
  const dir = mkdtempSync(join(tmpdir(), 'tg-ref-io-'));
  let digest = '';
  for (let i = 0; i < 200; i++) {
    writeFileSync(join(dir, 'f' + i), digest + i);
    digest = createHash('sha256').update(readFileSync(join(dir, 'f' + i))).digest('hex');
  }
  rmSync(dir, { recursive: true, force: true });
  assert.equal(digest.length, 64);
  assert.ok(x >= 0);
});
`;

/**
 * Starts the fixed test project `runs` times (after one warm-up that is not
 * counted) and returns every sample and their median. A run that fails is an
 * error, never a short sample: a number from a broken workload is not a speed.
 */
export function measureReference({ runs = 9 } = {}) {
  if (!Number.isInteger(runs) || runs < 3 || runs % 2 === 0) throw new RangeError('measureReference: runs must be an odd integer of at least 3');
  const dir = mkdtempSync(join(tmpdir(), 'tg-reference-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    writeFileSync(join(dir, 'reference.test.mjs'), TEST_SOURCE);
    const once = () => {
      const start = performance.now();
      const r = spawnSync(process.execPath, ['--test', 'reference.test.mjs'], { cwd: dir, stdio: 'ignore', timeout: 120_000 });
      const ms = performance.now() - start;
      if (r.status !== 0) throw new Error(`reference workload failed (status ${r.status}, signal ${r.signal})`);
      return ms;
    };
    once();
    const samplesMs = Array.from({ length: runs }, once);
    return { schemaVersion: 1, workload: WORKLOAD, node: process.versions.node, cpus: availableParallelism(), runs, samplesMs, medianMs: median(samplesMs) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, runs: { type: 'string', default: '9' } } });
  if (!values.out) {
    console.error('usage: measure-reference.mjs --out <file> [--runs 9]');
    process.exit(2);
  }
  const result = measureReference({ runs: Number(values.runs) });
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, JSON.stringify(result, null, 2) + '\n');
  console.log(`reference ${WORKLOAD}: median ${result.medianMs.toFixed(1)} ms of ${result.runs} (samples ${result.samplesMs.map((x) => x.toFixed(0)).join(', ')}) on ${result.cpus} CPUs, node ${result.node}`);
}
