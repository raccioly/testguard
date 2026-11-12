// TESTGUARD_WORKER (raccioly/testguard#287): every runner process learns the
// index of the scratch tree it runs in, so a suite can derive a port of its own.
import { it, expect } from 'vitest';
import { withWorker, workerEnv } from '../src/probe/worker-env.mjs';
import { runProcess } from '../src/probe/runners/shared.mjs';

it('is 0 outside any tree, the tree index inside one, and never leaks between concurrent trees', async () => {
  expect(workerEnv()).toEqual({ TESTGUARD_WORKER: '0' });
  const seen = await Promise.all([3, 1].map((i) => withWorker(i, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5 * i));
    return workerEnv().TESTGUARD_WORKER;
  })));
  expect(seen).toEqual(['3', '1']);
});

it('reaches the runner process the probe spawns', async () => {
  const script = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, worker: process.env.TESTGUARD_WORKER }))";
  const result = await withWorker(2, () => runProcess({ projectDir: process.cwd(), files: [], budgetMs: 20_000, argv: (files, out) => [process.execPath, '-e', script, out], parse: (doc) => ({ run: { outcome: 'pass', durationMs: 0 }, worker: (typeof doc === 'string' ? JSON.parse(doc) : doc).worker }) }));
  expect(result.worker ?? result.run?.worker).toBe('2');
}, 30_000);
