// `testguard clean` and the cleanup a probe does before it starts (#311),
// through the real command line entry point, in process.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { ownersDir } from '../src/clean/owner.mjs';
import { formatBytes } from '../src/commands/clean.mjs';
import { project } from './helpers/scope-project.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const dir = (prefix) => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(d); return d; };

const run = async (argv) => {
  const out = []; const err = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

/** A tree an abandoned run left: owner is a pid that is not running (a child that already exited would be reused; this one cannot exist). */
const DEAD = 2 ** 22 + 12345;
function orphan(base, name = 'testguard-abcdef') {
  mkdirSync(join(base, name, 'src'), { recursive: true });
  writeFileSync(join(base, name, 'src', 'a.txt'), 'x'.repeat(5000));
  mkdirSync(ownersDir(base), { recursive: true });
  writeFileSync(join(ownersDir(base), `${name}.json`), JSON.stringify({ pid: DEAD, host: hostname(), at: new Date().toISOString() }));
  return join(base, name);
}

describe('testguard clean', () => {
  it('removes an orphan, says how much it freed, and exits 0', async () => {
    const base = dir('tg-clean-cli-');
    const tree = orphan(base);
    const r = await run(['clean', base, '--scratch-dir', base]);
    expect(r.code).toBe(0);
    expect(existsSync(tree)).toBe(false);
    expect(r.out).toMatch(/^removed 1 scratch tree \(\d+(\.\d)? KB\)$/m);
    expect(r.out).toMatch(/^freed \d+(\.\d)? KB under /m);
  });

  it('--dry-run lists what it would remove and removes nothing', async () => {
    const base = dir('tg-clean-cli-');
    const tree = orphan(base);
    const r = await run(['clean', base, '--scratch-dir', base, '--dry-run']);
    expect(r.code).toBe(0);
    expect(existsSync(tree)).toBe(true);
    expect(existsSync(join(ownersDir(base), 'testguard-abcdef.json'))).toBe(true);
    expect(r.out).toMatch(/^would remove 1 scratch tree/m);
    expect(r.out).toContain(`${tree} — its owner (pid ${DEAD}) is gone`);
    expect(r.out).toMatch(/^would free /m);
  });

  it('--json is one document with the entries, the registrations and the total', async () => {
    const base = dir('tg-clean-cli-');
    orphan(base);
    const r = await run(['clean', base, '--scratch-dir', base, '--dry-run', '--json']);
    const doc = JSON.parse(r.out);
    expect(doc).toMatchObject({ base, dryRun: true, capped: false, failed: [], worktrees: [] });
    expect(doc.removed).toHaveLength(1);
    expect(doc.removed[0]).toMatchObject({ kind: 'scratch-tree' });
    expect(doc.bytes).toBe(doc.removed[0].bytes);
    expect(doc.bytes).toBeGreaterThan(0);
  });

  it('says so when there is nothing to clean, and never touches a young tree with no owner or a live one', async () => {
    const base = dir('tg-clean-cli-');
    mkdirSync(join(base, 'testguard-young01'));
    mkdirSync(join(base, 'testguard-live001'));
    mkdirSync(ownersDir(base), { recursive: true });
    writeFileSync(join(ownersDir(base), 'testguard-live001.json'), JSON.stringify({ pid: process.pid, host: hostname(), at: 'x' }));
    const old = new Date(Date.now() - 400 * 24 * 3600 * 1000);
    utimesSync(join(base, 'testguard-live001'), old, old);
    const r = await run(['clean', base, '--scratch-dir', base]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`nothing to clean under ${base}`);
    expect(readdirSync(base).sort()).toEqual(['testguard-live001', 'testguard-locks', 'testguard-young01']);
  });

  it('--dry-run belongs to clean only', async () => {
    const r = await run(['status', '.', '--dry-run']);
    expect(r.code).toBe(3);
    expect(r.err).toBe('--dry-run is only valid on clean');
  });

  it('sizes read as people read them', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(130 * 1024 ** 3)).toBe('130 GB');
  });
});

describe('a probe cleans before it starts', () => {
  it('removes an abandoned tree under its scratch root, quietly except for one note, before doing anything else', async () => {
    const base = dir('tg-clean-cli-');
    const tree = orphan(base);
    const p = project();
    roots.push(p.root);
    // The claim does not exist: the command refuses at once, after the cleanup ran.
    const r = await run(['probe', p.dir, '--claim', 'NO-SUCH-CLAIM', '--scratch-dir', base, '--progress', 'none']);
    expect(r.code).not.toBe(0);
    expect(existsSync(tree)).toBe(false);
    expect(r.err).toContain('cleaned 1 leftover scratch entry from interrupted runs');
  });

  it('a live probe\'s tree under the same scratch root is left alone', async () => {
    const base = dir('tg-clean-cli-');
    const tree = orphan(base);
    writeFileSync(join(ownersDir(base), 'testguard-abcdef.json'), JSON.stringify({ pid: process.pid, host: hostname(), at: 'x' }));
    const p = project();
    roots.push(p.root);
    await run(['probe', p.dir, '--claim', 'NO-SUCH-CLAIM', '--scratch-dir', base, '--progress', 'none']);
    expect(existsSync(tree)).toBe(true);
  });

  it('--quiet drops the note, not the cleanup', async () => {
    const base = dir('tg-clean-cli-');
    const tree = orphan(base);
    const p = project();
    roots.push(p.root);
    const r = await run(['probe', p.dir, '--claim', 'NO-SUCH-CLAIM', '--scratch-dir', base, '--quiet']);
    expect(existsSync(tree)).toBe(false);
    expect(r.err).not.toContain('leftover');
  });
});
