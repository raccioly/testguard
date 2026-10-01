import { argvFor as playwrightArgv } from '../src/probe/runners/playwright.mjs';
import { describe, it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProcess } from '../src/probe/runners/shared.mjs';
import { costReport } from '../src/probe/cost.mjs';
import { argvFor as vitestArgv } from '../src/probe/runners/vitest.mjs';
import { argvFor as jestArgv } from '../src/probe/runners/jest.mjs';
import { main, commandUsage } from '../src/cli.mjs';
import { argvFor as pythonArgv } from '../src/probe/runners/python.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, testResults: [] };

async function waitFor(predicate, ms = 4000) {
  const until = Date.now() + ms;
  while (!predicate() && Date.now() < until) await sleep(20);
  expect(predicate()).toBe(true);
}

function running(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'win32') return true;
    return !execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: 1000 }).trim().startsWith('Z');
  } catch { return false; }
}

describe('bounded runner resources', () => {
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

  it.each(['SIGINT', 'SIGTERM'])('cancels owned runners before restoring and cleaning isolation (%s)', async (signal) => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-cancel-test-'));
    const isolated = join(dir, 'isolated');
    const pidPath = join(dir, 'runner.pid');
    const restoredPath = join(dir, 'restored');
    const stoppedPath = join(dir, 'stopped');
    const evidencePath = join(dir, 'cancelled-evidence.json');
    const sample = JSON.parse(readFileSync(new URL('../spec/conformance/examples/evidence.json', import.meta.url), 'utf8'));
    const writer = new URL('../src/evidence/writer.mjs', import.meta.url).href;
    const inject = new URL('../src/probe/inject.mjs', import.meta.url).href;
    const lifecycle = new URL('../src/probe/runners/lifecycle.mjs', import.meta.url).href;
    const shared = new URL('../src/probe/runners/shared.mjs', import.meta.url).href;
    const runner = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);`;
    const source = `import {writeSpecDoc} from ${JSON.stringify(writer)};import * as fs from 'node:fs';import {registerCleanup} from ${JSON.stringify(lifecycle)};import {applyContent} from ${JSON.stringify(inject)};import {runProcess} from ${JSON.stringify(shared)};fs.mkdirSync(${JSON.stringify(isolated)});fs.writeFileSync(${JSON.stringify(join(isolated, 'target'))},'original');applyContent(${JSON.stringify(isolated)},'target','warmup').restore();registerCleanup(()=>{try{writeSpecDoc('evidence',${JSON.stringify(evidencePath)},${JSON.stringify(sample)});}catch{}let alive=false;try{process.kill(Number(fs.readFileSync(${JSON.stringify(pidPath)},'utf8')),0);alive=true;}catch{}fs.writeFileSync(${JSON.stringify(stoppedPath)},String(alive));fs.writeFileSync(${JSON.stringify(restoredPath)},fs.readFileSync(${JSON.stringify(join(isolated, 'target'))},'utf8'));fs.rmSync(${JSON.stringify(isolated)},{recursive:true,force:true});});applyContent(${JSON.stringify(isolated)},'target','mutated');await runProcess({projectDir:${JSON.stringify(isolated)},files:[],budgetMs:10000,command:[process.execPath,'-e',${JSON.stringify(runner)}]});`;
    const parent = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'ignore' });
    let pid;
    try {
      await waitFor(() => existsSync(pidPath));
      pid = Number(readFileSync(pidPath, 'utf8'));
      expect(running(pid)).toBe(true);
      parent.kill(signal);
      await waitFor(() => parent.exitCode !== null);
      expect(parent.exitCode).toBe(130);
      expect(running(pid)).toBe(false);
      expect(readFileSync(stoppedPath, 'utf8')).toBe('false');
      expect(readFileSync(restoredPath, 'utf8')).toBe('original');
      expect(existsSync(isolated)).toBe(false);
      expect(existsSync(evidencePath)).toBe(false);
    } finally {
      if (pid && running(pid)) { try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); } catch {} }
      parent.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 7000);

  it('documents worker controls on every measuring command', () => {
    for (const command of ['probe', 'sweep', 'replay', 'admit']) expect(commandUsage(command)).toContain('--workers');
  });

  it('rejects invalid worker ceilings before any runner starts', async () => {
    for (const command of ['probe', 'sweep', 'replay', 'admit']) {
      for (const workers of ['0', '-1', '1.5', 'nope', '9007199254740992']) {
        const errors = [];
        const args = [command, '.', ...(command === 'replay' ? ['--since', 'HEAD~1..HEAD'] : command === 'admit' ? ['--claim', 'C'] : []), `--workers=${workers}`];
        expect(await main(args, { out: () => {}, err: (line) => errors.push(line) })).toBe(3);
        expect(errors.join('\n')).toContain('--workers must be a positive safe integer');
      }
    }
  });

  it('keeps historical cost distinct from fresh invocation measurements', () => {
    const records = [{ claim: { id: 'C' }, subject: { id: 'F' }, defenders: { resolved: ['t.mjs'] }, detail: { baselineRuns: [{ durationMs: 1000 }], probeRuns: [{ durationMs: 1000 }] }, reusedFrom: 'old' }];
    const measurements = { elapsedMs: 10, runnerMs: 0, overheadMs: 10, runnerInvocations: 0 };
    expect(costReport(records, { run: { measurements } })).toMatchObject({ totalMs: 2000, measurements });
    expect(costReport(records)).not.toHaveProperty('measurements');
  });
});
