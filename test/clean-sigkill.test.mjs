// #311's acceptance: a probe killed with SIGKILL cannot clean up after itself,
// and the next probe removes its scratch tree AND its worktree registration.
// Real child processes, a real scratch worktree, a real git repository.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { project } from './helpers/scope-project.mjs';

const cli = fileURLToPath(new URL('../cli/testguard.mjs', import.meta.url));
const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

const slowDefender = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/price.mjs';\n\ntest('price', async () => {\n  await new Promise((resolve) => setTimeout(resolve, 60_000));\n  assert.equal(total(1, 2), 3);\n});\n";
const scratchTrees = (dir) => readdirSync(dir).filter((name) => /^testguard-[A-Za-z0-9]{6}$/.test(name));
const registrations = (dir) => execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('worktree ')).length;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a probe killed with SIGKILL', () => {
  it('leaves its tree and registration, and the next probe removes both', async () => {
    const p = project({ files: { 'test/price.test.mjs': slowDefender } });
    roots.push(p.root);
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tg-kill-scratch-')));
    roots.push(scratch);
    // Its own process group, so the kill takes the runner with it and nothing sleeps on afterwards.
    const child = spawn(process.execPath, [cli, 'probe', p.dir, '--claim', 'PRICE-TOTAL', '--runner', 'node-test', '--confirm', '1', '--scratch-dir', scratch, '--progress', 'none'], { stdio: 'ignore', detached: true });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const deadline = Date.now() + 30_000;
    while (scratchTrees(scratch).length === 0 || registrations(p.dir) < 2) {
      if (Date.now() > deadline) { process.kill(-child.pid, 'SIGKILL'); throw new Error('no scratch worktree appeared'); }
      await sleep(100);
    }
    process.kill(-child.pid, 'SIGKILL');
    expect((await exited).signal).toBe('SIGKILL');
    // The kill gave it no chance to clean up: the evidence the next probe must act on.
    expect(scratchTrees(scratch).length).toBeGreaterThan(0);
    expect(registrations(p.dir)).toBeGreaterThanOrEqual(2);

    // The next probe, on the same repository and scratch root: refused at once (no such claim), but its cleanup ran first.
    const next = spawn(process.execPath, [cli, 'probe', p.dir, '--claim', 'NO-SUCH-CLAIM', '--scratch-dir', scratch, '--progress', 'none'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    next.stderr.on('data', (d) => { stderr += d; });
    await new Promise((resolve) => next.once('exit', resolve));
    expect(stderr).toMatch(/cleaned \d+ leftover scratch entr/);
    expect(scratchTrees(scratch)).toEqual([]);
    expect(registrations(p.dir)).toBe(1);
  }, 90_000);
});
