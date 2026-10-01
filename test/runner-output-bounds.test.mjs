import { it, expect } from 'vitest';
import { runProcess } from '../src/probe/runners/shared.mjs';
const report = { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, testResults: [] };
  it('drains stdout beyond pipe capacity without manufacturing a timeout', async () => {
    const res = await runProcess({ projectDir: process.cwd(), files: [], budgetMs: 4000,
      argv: (_files, out) => [process.execPath, '-e', `process.stdout.write('x'.repeat(1024*1024), () => require('node:fs').writeFileSync(${JSON.stringify(out)}, ${JSON.stringify(JSON.stringify(report))}));`],
    });
    expect(res.run.outcome).toBe('pass');
    expect(res.run.tests.total).toBe(1);
  }, 6000);

  it('bounds retained stderr while preserving the final diagnostic', async () => {
    const res = await runProcess({ projectDir: process.cwd(), files: [], budgetMs: 4000,
      command: [process.execPath, '-e', `process.stderr.write('x'.repeat(1024*1024)+'FINAL_DIAGNOSTIC');`],
    });
    expect(res.run.outcome).toBe('error');
    expect(res.run.assertionFailures).toBe(0);
    expect(res.loadMessage).toHaveLength(65536);
    expect(res.loadMessage.endsWith('FINAL_DIAGNOSTIC')).toBe(true);
  }, 6000);

  it('refuses oversized reports before parsing and never credits a kill', async () => {
    const res = await runProcess({ projectDir: process.cwd(), files: [], budgetMs: 4000,
      argv: (_files, out) => [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(out)},' '.repeat(16*1024*1024)+${JSON.stringify(JSON.stringify(report))});`],
    });
    expect(res.run.outcome).toBe('error');
    expect(res.run.assertionFailures).toBe(0);
    expect(res.loadMessage).toMatch(/exceed|limit|large/i);
  }, 6000);

