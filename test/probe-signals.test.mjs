// Defect C of the 0.22.1 verification: SIGTERM exited 130, the code that means
// SIGINT. A shell reports 128 plus the signal number, and a supervisor that
// sends SIGTERM reads 143 as "terminated, as asked". Both signals now exit with
// their own code, say so once on stderr, and clean up identically. The probe
// under test is a real child process with a real scratch worktree.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { project } from './helpers/scope-project.mjs';

const cli = fileURLToPath(new URL('../cli/testguard.mjs', import.meta.url));
const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

const slowDefender = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/price.mjs';\n\ntest('price', async () => {\n  await new Promise((resolve) => setTimeout(resolve, 60_000));\n  assert.equal(total(1, 2), 3);\n});\n";
/** The scratch directory's contents: the allocation lock directory is permanent infrastructure, not a scratch tree. */
const scratchTrees = (dir) => readdirSync(dir).filter((name) => name !== 'testguard-locks');
const worktrees = (dir) => execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('worktree ')).length;

/** Start a probe whose defender sleeps; resolve once its scratch worktree exists, so a signal lands mid-measurement. */
async function probeInFlight() {
  const p = project({ files: { 'test/price.test.mjs': slowDefender } });
  roots.push(p.root);
  const scratch = mkdtempSync(join(tmpdir(), 'tg-sig-scratch-'));
  roots.push(scratch);
  const child = spawn(process.execPath, [cli, 'probe', p.dir, '--claim', 'PRICE-TOTAL', '--runner', 'node-test', '--confirm', '1', '--scratch-dir', scratch, '--progress', 'none'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 30_000;
  while (scratchTrees(scratch).length === 0 || worktrees(p.dir) < 2) {
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`no scratch worktree appeared; stderr: ${stderr}`); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { p, scratch, child, exited, stderr: () => stderr };
}

describe('an interrupted probe exits with the conventional code for the signal and leaves nothing behind', () => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    it(`${signal} exits ${code}, says so once, and removes the scratch tree`, async () => {
      const run = await probeInFlight();
      // The tree existed while the probe ran: a cleanup assertion over nothing would pass on any build.
      expect(scratchTrees(run.scratch).length).toBeGreaterThan(0);
      expect(worktrees(run.p.dir)).toBeGreaterThanOrEqual(2);
      run.child.kill(signal);
      const result = await run.exited;
      expect(result.code).toBe(code);
      expect(run.stderr().split('\n').filter((l) => l.startsWith('interrupted by'))).toEqual([`interrupted by ${signal}; scratch trees removed`]);
      expect(scratchTrees(run.scratch)).toEqual([]);
      expect(worktrees(run.p.dir)).toBe(1);
      expect(existsSync(join(run.p.dir, '.testguard', 'evidence.json'))).toBe(false);
    }, 60_000);
  }
});
