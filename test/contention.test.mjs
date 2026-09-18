// @req NFR-06
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect } from 'vitest';
import { processList, detectContention, contentionWarning } from '../src/probe/contention.mjs';

/** A fake `spawnSync` that returns a canned process table. */
const fakePs = (stdout, status = 0) => () => ({ status, stdout });

const PS = `  501 /usr/bin/node /repo/node_modules/vitest/vitest.mjs run src/x.test.ts
  502 /usr/bin/node /other/node_modules/jest/bin/jest.js --ci
  503 /usr/bin/node /repo/cli/testguard.mjs probe .
  504 ps -Ao pid=,args=
  505 /usr/bin/node /repo/node_modules/vitest/vitest.mjs run --reporter=json --outputFile=/tmp/testguard-run-abc.json
  506 -zsh
`;

describe('processList', () => {
  it('parses pid and command from ps, and returns nothing when it cannot be read', () => {
    const rows = processList({ platform: 'darwin', run: fakePs(PS) });
    expect(rows.slice(0, 2)).toEqual([
      { pid: 501, command: '/usr/bin/node /repo/node_modules/vitest/vitest.mjs run src/x.test.ts' },
      { pid: 502, command: '/usr/bin/node /other/node_modules/jest/bin/jest.js --ci' },
    ]);
    expect(processList({ platform: 'darwin', run: fakePs('', 1) })).toEqual([]);
    expect(processList({ platform: 'darwin', run: () => { throw new Error('nope'); } })).toEqual([]);
  });

  it('parses the windows csv shape', () => {
    const csv = 'Node,CommandLine,ProcessId\nHOST,"C:\\\\node.exe C:\\\\repo\\\\node_modules\\\\vitest\\\\vitest.mjs run",4242\n';
    expect(processList({ platform: 'win32', run: fakePs(csv) })).toEqual([{ pid: 4242, command: '"C:\\\\node.exe C:\\\\repo\\\\node_modules\\\\vitest\\\\vitest.mjs run"' }]);
  });
});

describe('detectContention', () => {
  // These pids are scripted, so they are not running on the machine under test.
  // Liveness is a separate concern with its own describe below; pin it here so
  // the filtering, truncation and warning cases stay pure.
  const live = () => true;

  it('finds other runners, and never counts this process, our own probe, or ps itself', () => {
    const c = detectContention({ platform: 'darwin', run: fakePs(PS), self: 505, alive: live });
    expect(c.detected).toBe(true);
    expect(c.runners.map((r) => r.pid)).toEqual([501, 502]); // 503 is testguard, 504 is ps, 505 is us, 506 is a shell
  });

  it('is not detected when nothing else runs, and never throws on an unreadable process list', () => {
    expect(detectContention({ platform: 'darwin', run: fakePs('  506 -zsh\n'), self: 1, alive: live })).toEqual({ detected: false, runners: [] });
    expect(detectContention({ platform: 'darwin', run: fakePs('', 1), self: 1, alive: live })).toEqual({ detected: false, runners: [] });
  });

  it('truncates a very long command line so the evidence stays readable', () => {
    const long = `  700 /usr/bin/node /x/node_modules/vitest/vitest.mjs ${'a'.repeat(400)}\n`;
    const c = detectContention({ platform: 'darwin', run: fakePs(long), self: 1, alive: live });
    expect(c.runners[0].command).toHaveLength(198);
    expect(c.runners[0].command.endsWith('…')).toBe(true);
  });
});

describe('contentionWarning', () => {
  it('names the pids and says what a contended run costs and what to do', () => {
    const w = contentionWarning(detectContention({ platform: 'darwin', run: fakePs(PS), self: 505, alive: () => true }));
    expect(w).toContain('2 test runners are already running (pid 501, pid 502)');
    expect(w).toMatch(/TIMEOUT or FLAKY-DEFENDER — verdicts about the load, not the claim/);
    expect(w).toContain('--serial');
  });
});

describe('a runner that has already exited is not contention', () => {
  // A field report saw "1 test runner is already running (pid 65751)" for a
  // process that had exited by the time it looked. `ps` is a snapshot; a suite
  // that finishes between the snapshot and the warning is reported as load
  // that no longer exists, and the operator cannot even verify it — the pid is
  // gone. Best-effort detection stays best-effort, but it may not invent work.
  const ps = fakePs('  4242 node ./node_modules/.bin/vitest run\n  4243 node ./node_modules/.bin/jest\n');

  it('drops a pid that is no longer alive', () => {
    const c = detectContention({ self: 1, run: ps, platform: 'darwin', alive: (pid) => pid !== 4242 });
    expect(c.detected).toBe(true);
    expect(c.runners.map((r) => r.pid)).toEqual([4243]);
  });

  it('reports nothing at all when every runner it saw has since exited', () => {
    const c = detectContention({ self: 1, run: ps, platform: 'darwin', alive: () => false });
    expect(c).toEqual({ detected: false, runners: [] });
  });

  it('keeps a pid it may not signal — EPERM means running, not gone', () => {
    const c = detectContention({ self: 1, run: ps, platform: 'darwin', alive: () => true });
    expect(c.runners.map((r) => r.pid)).toEqual([4242, 4243]);
  });
});
