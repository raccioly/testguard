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
  it('finds other runners, and never counts this process, our own probe, or ps itself', () => {
    const c = detectContention({ platform: 'darwin', run: fakePs(PS), self: 505 });
    expect(c.detected).toBe(true);
    expect(c.runners.map((r) => r.pid)).toEqual([501, 502]); // 503 is testguard, 504 is ps, 505 is us, 506 is a shell
  });

  it('is not detected when nothing else runs, and never throws on an unreadable process list', () => {
    expect(detectContention({ platform: 'darwin', run: fakePs('  506 -zsh\n'), self: 1 })).toEqual({ detected: false, runners: [] });
    expect(detectContention({ platform: 'darwin', run: fakePs('', 1), self: 1 })).toEqual({ detected: false, runners: [] });
  });

  it('truncates a very long command line so the evidence stays readable', () => {
    const long = `  700 /usr/bin/node /x/node_modules/vitest/vitest.mjs ${'a'.repeat(400)}\n`;
    const c = detectContention({ platform: 'darwin', run: fakePs(long), self: 1 });
    expect(c.runners[0].command).toHaveLength(198);
    expect(c.runners[0].command.endsWith('…')).toBe(true);
  });
});

describe('contentionWarning', () => {
  it('names the pids and says what a contended run costs and what to do', () => {
    const w = contentionWarning(detectContention({ platform: 'darwin', run: fakePs(PS), self: 505 }));
    expect(w).toContain('2 test runners are already running (pid 501, pid 502)');
    expect(w).toMatch(/TIMEOUT or FLAKY-DEFENDER — verdicts about the load, not the claim/);
    expect(w).toContain('--serial');
  });
});
