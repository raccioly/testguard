// What a timed-out run says beyond its verdict: pure rules (#310).
import { describe, it, expect } from 'vitest';
import { BUDGET_GRACE_MS } from '../src/probe/runners/shared.mjs';
import { annotateTimeout, timeoutContentionNote, teardownWarning } from '../src/probe/contention.mjs';

const runner = (pid) => ({ pid, command: 'node vitest' });

describe('what a timed-out run says beyond its verdict', () => {
  it('a count of busy runners makes the timeout an environment condition, never names', () => {
    expect(timeoutContentionNote({ detected: false, runners: [] })).toBe('');
    expect(timeoutContentionNote(undefined)).toBe('');
    const one = timeoutContentionNote({ detected: true, runners: [runner(11)] });
    expect(one).toMatch(/^1 other test runner was busy .*environment condition/);
    expect(one).not.toContain('11');
    expect(timeoutContentionNote({ detected: true, runners: [runner(1), runner(2)] })).toMatch(/^2 other test runners were busy/);
  });

  it('annotateTimeout adds the note to the message, warns once for an unconfirmed teardown, and keeps the verdict', () => {
    const warnings = [];
    const result = { run: { outcome: 'timeout' }, timeouts: 1, loadMessage: 'budget of 1000ms exceeded', teardown: { unconfirmed: true, alive: 2, unlisted: false, pipeHeld: true } };
    annotateTimeout(result, { contention: { detected: true, runners: [runner(7)] }, onWarn: (line) => warnings.push(line), graceMs: 5000 });
    expect(result.run.outcome).toBe('timeout');
    expect(result.loadMessage).toMatch(/^budget of 1000ms exceeded; 1 other test runner was busy/);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(teardownWarning(result.teardown, 5000));
    expect(warnings[0]).toMatch(/2 processes still alive; its output pipe is held by a process TestGuard could not find/);
    const quiet = [];
    annotateTimeout({ run: { outcome: 'timeout' }, loadMessage: 'x' }, { contention: { detected: false, runners: [] }, onWarn: (line) => quiet.push(line), graceMs: 5000 });
    expect(quiet).toEqual([]);
  });

  it('the grace is five seconds', () => {
    expect(BUDGET_GRACE_MS).toBe(5000);
  });
});
