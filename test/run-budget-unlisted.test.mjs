// A process table that never reads is an unverified teardown (#310).
import { afterEach, describe, it, expect } from 'vitest';
import { FIXTURES, cleanup, timed, bounded } from './helpers/process-tree.mjs';

afterEach(cleanup);

describe('A process table that never reads is an unverified teardow', () => {
  it('a process table that never reads is an unverified teardown', async () => {
    const run = await timed(FIXTURES.webServer, { processList: () => () => null });
    bounded(run);
    expect(run.result.teardown).toMatchObject({ unconfirmed: true, unlisted: true });
    expect(run.result.loadMessage).toMatch(/teardown NOT confirmed: .*process table could not be read/);
  });
});
