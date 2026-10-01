import { it, expect } from 'vitest';
import { argvFor as vitestArgv } from '../src/probe/runners/vitest.mjs';
import { argvFor as jestArgv } from '../src/probe/runners/jest.mjs';
import { argvFor as pythonArgv } from '../src/probe/runners/python.mjs';
import { argvFor as playwrightArgv } from '../src/probe/runners/playwright.mjs';
  it('caps native workers and lets serial override a larger ceiling', () => {
    expect(vitestArgv(process.cwd(), [], '/tmp/report')).toContain('--maxWorkers=1');
    expect(jestArgv(process.cwd(), [], '/tmp/report')).toContain('--runInBand');
    expect(vitestArgv(process.cwd(), [], '/tmp/report', { workers: 2 })).toContain('--maxWorkers=2');
    expect(jestArgv(process.cwd(), [], '/tmp/report', { workers: 2 })).toContain('--maxWorkers=2');
    expect(vitestArgv(process.cwd(), [], '/tmp/report', { workers: 2, serial: true })).toContain('--maxWorkers=1');
    expect(jestArgv(process.cwd(), [], '/tmp/report', { workers: 2, serial: true })).toContain('--runInBand');
    const python = pythonArgv({ engine: 'pytest', interpreter: '/python', files: ['t.py'], serial: false });
    expect(python).toContain('no:xdist');
    expect(playwrightArgv(process.cwd(), [])).toContain('--workers=1');
    expect(playwrightArgv(process.cwd(), [], { workers: 2 })).toContain('--workers=2');
    expect(playwrightArgv(process.cwd(), [], { workers: 2, serial: true })).toContain('--workers=1');
    expect(playwrightArgv(process.cwd(), [])[0]).not.toBe('npx');
  });

