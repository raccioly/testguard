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
const scratchTrees = (dir) => readdirSync(dir).filter((name) => /^testguard-[A-Za-z0-9]{6}$/.test(name)).sort();
const ownerRecords = (dir) => { try { return readdirSync(join(dir, 'testguard-locks', 'owners')).sort(); } catch { return []; } };
const registered = (dir) => execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a probe killed with SIGKILL', () => {
  it('leaves its tree and registration, and the next probe removes both', async () => {
    const p = project({ files: { 'test/price.test.mjs': slowDefender } });
    roots.push(p.root);
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tg-kill-scratch-')));
    roots.push(scratch);
    // Its own process group, so the kill takes the runner with it and nothing sleeps on afterwards. One fault at a time: one scratch tree, not a fan-out's several.
    const child = spawn(process.execPath, [cli, 'probe', p.dir, '--claim', 'PRICE-TOTAL', '--runner', 'node-test', '--confirm', '1', '--fault-workers', '1', '--scratch-dir', scratch, '--progress', 'none'], { stdio: 'ignore', detached: true });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    // Kill only once the tree, its owner record and its registration all exist, observed, never assumed from a sleep.
    // Generous: a fan-out of probes on a busy machine can take a minute to get this far, and the wait ends the moment they exist.
    const deadline = Date.now() + 120_000;
    while (scratchTrees(scratch).length === 0 || ownerRecords(scratch).length === 0 || registered(p.dir).length < 2) {
      if (Date.now() > deadline) { process.kill(-child.pid, 'SIGKILL'); throw new Error('no scratch worktree appeared'); }
      await sleep(50);
    }
    process.kill(-child.pid, 'SIGKILL');
    expect((await exited).signal).toBe('SIGKILL');
    // The kill gave it no chance to clean up. These are the exact trees and registrations the next probe must remove.
    const orphans = scratchTrees(scratch);
    expect(orphans.length).toBeGreaterThan(0);
    const orphanPaths = orphans.map((name) => join(scratch, name));
    for (const path of orphanPaths) expect(registered(p.dir)).toContain(path);

    // The next probe, on the same repository and scratch root: refused at once (no such claim), but its cleanup ran first.
    const next = spawn(process.execPath, [cli, 'probe', p.dir, '--claim', 'NO-SUCH-CLAIM', '--scratch-dir', scratch, '--progress', 'none'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    next.stderr.on('data', (d) => { stderr += d; });
    await new Promise((resolve) => next.once('exit', resolve));
    // The note counts every kind of leftover (trees, stale locks, owner records); the exact trees are checked below.
    expect(Number(/cleaned (\d+) leftover scratch/.exec(stderr)?.[1])).toBeGreaterThanOrEqual(orphans.length);
    for (const name of orphans) expect(scratchTrees(scratch)).not.toContain(name);
    for (const path of orphanPaths) expect(registered(p.dir)).not.toContain(path);
    expect(registered(p.dir)).toEqual([p.root]);
  }, 240_000);
});
