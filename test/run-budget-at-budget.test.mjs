// The bounded kill the type check and the interpreter check use (#310).
import { afterEach, describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { terminateAtBudget } from '../src/probe/runners/shared.mjs';
import { FIXTURES, cleanup, bounded, sleep, fresh, SLACK } from './helpers/process-tree.mjs';

afterEach(cleanup);

describe('The bounded kill the type check and the interpreter check', () => {
  it('lets a caller that waits on `close` move on when a survivor holds the pipe', async () => {
    const dir = fresh();
    const child = spawn(process.execPath, ['-e', FIXTURES.orphanHoldsPipe(dir)], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    const closed = new Promise((done) => child.once('close', done));
    await sleep(200);
    const started = Date.now();
    terminateAtBudget(child, 200);
    await closed;
    expect(Date.now() - started).toBeLessThanOrEqual(200 + SLACK);
  });
});
