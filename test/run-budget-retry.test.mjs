// A process table that fails to read is retried while the tree is frozen (#310).
import { afterEach, describe, it, expect } from 'vitest';
import { processRows } from '../src/probe/runners/shared.mjs';
import { FIXTURES, cleanup, timed, bounded, allDead } from './helpers/process-tree.mjs';

afterEach(cleanup);

describe('A process table that fails to read is retried while the t', () => {
  it('a process table that fails to read twice is retried while the tree is frozen, and the server is still found', async () => {
    let calls = 0;
    const run = await timed(FIXTURES.webServer, { processList: () => (options) => (++calls <= 2 ? null : processRows(options)) });
    bounded(run);
    expect(calls).toBeGreaterThan(2);
    expect(await allDead(run.pids)).toBe(true);
  });
});
