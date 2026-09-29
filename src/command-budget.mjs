import { PreconditionError } from './probe/worktree.mjs';
import { performance } from 'node:perf_hooks';

/**
 * A cooperative measurement deadline shared by every stage of one command.
 *
 * Per-run budgets answer "how long may this runner invocation take?". This
 * deadline answers the different question "may the whole command still
 * produce a result?". Async child processes receive no more than the
 * remaining time; synchronous setup can overrun because JavaScript cannot
 * preempt it, so every stage boundary and every write boundary checks again.
 * Expiry is deliberately not a verdict: a partial result would make the
 * unattempted suffix look clean.
 */
export class CommandBudget {
  constructor(limitMs, { now = () => performance.now() } = {}) {
    if (!Number.isInteger(limitMs) || limitMs < 1) throw new TypeError('command budget must be a positive integer');
    this.limitMs = limitMs;
    this.now = now;
    this.startedAtMs = now();
  }

  elapsedMs() {
    return Math.max(0, this.now() - this.startedAtMs);
  }

  remainingMs() {
    return Math.max(0, this.limitMs - this.elapsedMs());
  }

  assertOpen() {
    if (this.remainingMs() === 0) {
      throw new PreconditionError(`command budget of ${this.limitMs}ms exhausted; no partial result was written`);
    }
  }

  /** Never let a child process outlive the command's remaining measurement window. */
  runBudget(perRunMs) {
    this.assertOpen();
    return Math.max(1, Math.min(perRunMs, Math.floor(this.remainingMs())));
  }
}

export function createCommandBudget(limitMs, options) {
  return limitMs === undefined ? undefined : new CommandBudget(limitMs, options);
}

export function parseCommandBudget(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1000 ? parsed : null;
}
