// The teardown sends SIGKILL to the whole tree and finds a detached server through the process table (#310).
import { afterEach, describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { terminateProcessTree } from '../src/probe/runners/shared.mjs';
import { FIXTURES, cleanup, timed, bounded, allDead, pidsOf, sleep, fresh } from './helpers/process-tree.mjs';

afterEach(cleanup);

describe('the teardown kills the tree', () => {
  it('a webServer-style server of its own process group is found by its parent and killed', async () => {
    const run = await timed(FIXTURES.webServer);
    bounded(run);
    expect(run.pids.length).toBe(2);
    expect(await allDead(run.pids)).toBe(true);
    expect(run.result.teardown).toBeUndefined();
  });

});

describe('terminateProcessTree', () => {
  it('kills the group and its detached descendant before it returns, and says what it signaled', async () => {
    const dir = fresh();
    const child = spawn(process.execPath, ['-e', FIXTURES.webServer(dir)], { detached: true, stdio: 'ignore' });
    const until = Date.now() + 5000;
    while (pidsOf(dir).length < 2 && Date.now() < until) await sleep(25);
    expect(pidsOf(dir).length).toBe(2);
    const signaled = terminateProcessTree(child);
    expect(signaled.listed).toBe(true);
    expect(signaled.pids.length).toBeGreaterThanOrEqual(1);
    expect(await allDead(pidsOf(dir))).toBe(true);
  });

  it('says the table could not be read rather than treating it as an empty tree', async () => {
    const dir = fresh();
    const child = spawn(process.execPath, ['-e', FIXTURES.ignoresSigterm(dir)], { detached: true, stdio: 'ignore' });
    const until = Date.now() + 5000;
    while (pidsOf(dir).length < 1 && Date.now() < until) await sleep(25);
    const signaled = terminateProcessTree(child, { list: () => null, listMs: 100 });
    expect(signaled.listed).toBe(false);
    expect(await allDead(pidsOf(dir))).toBe(true);
  });
});
