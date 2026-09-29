import { describe, expect, it } from 'vitest';
import { CommandBudget, createCommandBudget, parseCommandBudget } from '../src/command-budget.mjs';
import { main } from '../src/cli.mjs';

describe('whole-command budget', () => {
  it('caps every child run at the remaining command time', () => {
    let now = 1_000;
    const budget = new CommandBudget(5_000, { now: () => now });
    expect(budget.runBudget(10_000)).toBe(5_000);
    now += 1_250;
    expect(budget.elapsedMs()).toBe(1_250);
    expect(budget.runBudget(10_000)).toBe(3_750);
    expect(budget.runBudget(500)).toBe(500);
  });

  it('fails closed at the deadline instead of authorizing a partial result', () => {
    let now = 10;
    const budget = new CommandBudget(1_000, { now: () => now });
    now = 1_010;
    expect(() => budget.assertOpen()).toThrow('no partial result was written');
    expect(() => budget.runBudget(120_000)).toThrow('command budget of 1000ms exhausted');
  });

  it('keeps the feature optional and validates the CLI boundary', () => {
    expect(createCommandBudget(undefined)).toBeUndefined();
    expect(parseCommandBudget(undefined)).toBeUndefined();
    expect(parseCommandBudget('1000')).toBe(1_000);
    for (const value of ['999', '1.5', 'nope', '-1']) expect(parseCommandBudget(value)).toBeNull();
  });

  it('rejects an invalid total before probe, sweep, or replay begins', async () => {
    for (const command of ['probe', 'sweep', 'replay']) {
      const lines = [];
      const args = [command, '.', ...(command === 'replay' ? ['--since', 'HEAD~1..HEAD'] : []), '--command-budget', '999'];
      const code = await main(args, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
      expect(code).toBe(3);
      expect(lines.join('\n')).toContain('--command-budget must be at least 1000 milliseconds');
    }
  });
});
