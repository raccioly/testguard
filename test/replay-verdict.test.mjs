// @req FR-13
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
//
// The pure half of replay's VERDICT: classifyReplay is a function from a list
// of run outcomes to a verdict — no git, no corpus, no runner. It lived in
// replay.test.mjs, which builds a scripted git repository and replays commits
// through it, and a claim pays for every test in the file it names. Same cut
// as test/label.test.mjs and test/calibration.test.mjs.
import { describe, it, expect } from 'vitest';
import { classifyReplay } from '../src/replay/replay.mjs';

describe('classifyReplay — the verdict, pure, every branch', () => {
  const pass = { outcome: 'pass', assertionFailures: 0, durationMs: 1 };
  const failed = { outcome: 'fail', assertionFailures: 1, durationMs: 1 };
  const nonAssertion = { outcome: 'fail', assertionFailures: 0, durationMs: 1 };
  const timeout = { outcome: 'timeout', durationMs: 1 };
  const error = { outcome: 'error', durationMs: 1 };

  it('caught only when EVERY run failed by assertion', () => {
    expect(classifyReplay([failed, failed, failed])).toEqual({ verdict: 'caught' });
  });

  it('a mixed result is flaky, never caught — one flaky failure would otherwise read as detection', () => {
    expect(classifyReplay([failed, pass, failed])).toEqual({ verdict: 'flaky', reason: 'runs-disagreed' });
    expect(classifyReplay([pass, failed])).toEqual({ verdict: 'flaky', reason: 'runs-disagreed' });
    // the optimistic reading is the one that hides a blind spot: refuse it
    expect(classifyReplay([failed, pass, pass]).verdict).not.toBe('caught');
  });

  it('blind only when every run passed', () => {
    expect(classifyReplay([pass, pass, pass])).toEqual({ verdict: 'blind' });
  });

  it('a failure that is not an assertion failure is not detection', () => {
    expect(classifyReplay([nonAssertion, nonAssertion])).toEqual({ verdict: 'unverifiable', reason: 'failed-without-an-assertion' });
  });

  it('a timeout or a load failure concludes nothing', () => {
    expect(classifyReplay([pass, timeout])).toEqual({ verdict: 'unverifiable', reason: 'timed-out' });
    expect(classifyReplay([error])).toEqual({ verdict: 'unverifiable', reason: 'suite-failed-to-load' });
    expect(classifyReplay([])).toEqual({ verdict: 'unverifiable', reason: 'no-runs' });
  });
});
