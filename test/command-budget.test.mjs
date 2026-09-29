import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CommandBudget, createCommandBudget, parseCommandBudget } from '../src/command-budget.mjs';
import { main } from '../src/cli.mjs';

describe('whole-command budget', () => {
  const scratch = [];
  afterEach(() => scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

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

  it('leaves no evidence document when the total expires inside a runner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'testguard-command-budget-'));
    scratch.push(dir);
    cpSync(fileURLToPath(new URL('../fixtures/known-answer/', import.meta.url)), dir, { recursive: true });
    const slow = join(dir, 'slow-runner.mjs');
    // Long enough to exceed the 1s command budget, short enough that mutating
    // the child-budget cap still returns control to this test and lets the
    // unit assertion above report a genuine failure instead of timing out the
    // entire defender file.
    writeFileSync(slow, 'setTimeout(() => {}, 2_000);\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dir });

    const out = join(dir, '.testguard', 'budget-evidence.json');
    const lines = [];
    const code = await main([
      'probe', dir, '--in-place', '--claim', 'REDACT-001', '--confirm', '1',
      '--command-budget', '1000', '--runner-cmd', `node ${slow} {files} {out}`, '--out', out,
    ], { out: (line) => lines.push(line), err: (line) => lines.push(line) });

    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('no partial result was written');
    expect(existsSync(out)).toBe(false);
  }, 8_000);
});
