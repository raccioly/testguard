import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertOpen: vi.fn(),
  probe: vi.fn(),
  replay: vi.fn(),
  sweep: vi.fn(),
  writeSpecDoc: vi.fn(),
}));

vi.mock('../src/command-budget.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  createCommandBudget: () => ({ assertOpen: mocks.assertOpen, runBudget: (ms) => ms }),
}));
vi.mock('../src/probe/probe.mjs', () => ({ probe: mocks.probe }));
vi.mock('../src/sweep/sweep.mjs', () => ({
  ConcernError: class ConcernError extends Error {},
  renderSweep: () => '',
  sweep: mocks.sweep,
}));
vi.mock('../src/replay/replay.mjs', () => ({
  calibrationFrom: () => ({ schemaVersion: 1, buckets: {} }),
  renderReplay: () => '',
  replay: mocks.replay,
}));
vi.mock('../src/evidence/writer.mjs', () => ({
  readSpecDoc: vi.fn(),
  writeSpecDoc: mocks.writeSpecDoc,
}));

const { probeCommand } = await import('../src/commands/probe.mjs');
const { sweepCommand } = await import('../src/commands/sweep.mjs');
const { replayCommand } = await import('../src/commands/replay.mjs');

const io = { out: vi.fn(), err: vi.fn() };
const exhausted = new Error('command budget exhausted; no partial result was written');

describe('whole-command result-write boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertOpen.mockImplementation(() => { throw exhausted; });
    mocks.probe.mockResolvedValue({ schemaVersion: 1, run: { id: 'run' }, records: [] });
    mocks.sweep.mockResolvedValue({ schemaVersion: 1, exitCode: 0, evidence: { records: [] } });
    mocks.replay.mockResolvedValue({ schemaVersion: 1, commits: [], records: [] });
  });

  it('probe refuses publication when expiry follows its post-measurement check', async () => {
    // The post-measurement guard is still open. Only the final write-boundary
    // guard observes expiry; an earlier refusal cannot defend that boundary.
    mocks.assertOpen.mockImplementationOnce(() => {});
    await expect(probeCommand({
      projectDir: process.cwd(),
      values: { confirm: '3', budget: '1000', 'command-budget': '1000', progress: 'none', quiet: true },
      version: 'test',
    }, io)).rejects.toThrow('no partial result was written');
    expect(mocks.writeSpecDoc).not.toHaveBeenCalled();
    expect(io.out).not.toHaveBeenCalled();
  });

  it.each([
    ['probe', () => probeCommand({
      projectDir: process.cwd(),
      values: { confirm: '3', budget: '1000', 'command-budget': '1000', progress: 'none', quiet: true },
      version: 'test',
    }, io)],
    ['sweep', () => sweepCommand({
      projectDir: process.cwd(),
      values: { confirm: '3', budget: '1000', 'command-budget': '1000', changed: 'HEAD', quiet: true },
      version: 'test',
    }, io)],
    ['replay', () => replayCommand({
      projectDir: process.cwd(),
      values: { confirm: '3', budget: '1000', 'command-budget': '1000', since: 'HEAD~1..HEAD', quiet: true },
      version: 'test',
    }, io)],
  ])('%s refuses to publish a completed in-memory result after the deadline', async (_name, command) => {
    await expect(command()).rejects.toThrow('no partial result was written');
    expect(mocks.writeSpecDoc).not.toHaveBeenCalled();
  });
});
