// @req FR-10
// The helpers the write-boundary acceptance tests stand on, checked fast and
// on their own: a listing that cannot see a write, or a diff that cannot report
// one, would let a leak pass the slow test.
import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changes, chmodTree, copyTree, listing } from './helpers/write-boundary.mjs';

const made = [];
const dir = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'tg-wbh-'))); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) { try { chmodTree(d, 'rw'); } catch {} rmSync(d, { recursive: true, force: true }); } });

describe('listing and changes', () => {
  it('lists files, directories and symlinks, and sees a created, a removed and a modified path', () => {
    const d = dir();
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'sub', 'kept.txt'), 'one');
    writeFileSync(join(d, 'sub', 'gone.txt'), 'x');
    writeFileSync(join(d, 'edited.txt'), 'a');
    symlinkSync(join(d, 'sub'), join(d, 'link'));
    const before = listing(d);
    expect([...before.keys()].sort()).toEqual(['.', 'edited.txt', 'link', 'sub', 'sub/gone.txt', 'sub/kept.txt']);
    expect(before.get('link').startsWith('l:')).toBe(true);
    rmSync(join(d, 'sub', 'gone.txt'));
    writeFileSync(join(d, 'new.txt'), 'n');
    writeFileSync(join(d, 'edited.txt'), 'abc'); // size changes
    utimesSync(join(d, 'sub', 'kept.txt'), new Date(0), new Date(86_400_000)); // only the mtime changes
    expect(changes(before, listing(d))).toEqual({ created: ['new.txt'], removed: ['sub/gone.txt'], modified: ['edited.txt', 'sub/kept.txt'] });
  });

  it('skips what the caller says is allowed, and reports nothing for an untouched tree', () => {
    const d = dir();
    mkdirSync(join(d, 'allowed'));
    writeFileSync(join(d, 'allowed', 'f'), '1');
    writeFileSync(join(d, 'x'), '1');
    const before = listing(d, (rel) => rel === 'allowed' || rel.startsWith('allowed/'));
    writeFileSync(join(d, 'allowed', 'g'), '2');
    expect(changes(before, listing(d, (rel) => rel === 'allowed' || rel.startsWith('allowed/')))).toEqual({ created: [], removed: [], modified: [] });
    expect(before.has('allowed/f')).toBe(false);
  });
});

describe('copyTree and chmodTree', () => {
  it('copies a tree with its symlinks kept as symlinks, so a chmod on the copy cannot reach the original', () => {
    const d = dir();
    mkdirSync(join(d, 'a', 'pkg'), { recursive: true });
    writeFileSync(join(d, 'a', 'pkg', 'f'), 'x');
    symlinkSync('pkg/f', join(d, 'a', 'rel-link'));
    copyTree(join(d, 'a'), join(d, 'b'));
    expect(lstatSync(join(d, 'b', 'rel-link')).isSymbolicLink()).toBe(true);
    chmodTree(join(d, 'b'), 'ro');
    expect(lstatSync(join(d, 'a', 'pkg', 'f')).mode & 0o222).not.toBe(0);
  });

  it('copies the CONTENTS of a source that is itself a symlink (a node_modules linked into a git worktree), never the link', () => {
    const d = dir();
    mkdirSync(join(d, 'real', 'vitest'), { recursive: true });
    writeFileSync(join(d, 'real', 'vitest', 'package.json'), '{}');
    symlinkSync(join(d, 'real'), join(d, 'node_modules'));
    copyTree(join(d, 'node_modules'), join(d, 'copy'));
    expect(lstatSync(join(d, 'copy')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(d, 'copy', 'vitest', 'package.json')).isFile()).toBe(true);
    chmodTree(join(d, 'copy'), 'ro');
    expect(lstatSync(join(d, 'real', 'vitest', 'package.json')).mode & 0o222).not.toBe(0);
  });

  it('removes write bits only: an executable stays executable, a read-only tree can be made writable again', () => {
    const d = dir();
    mkdirSync(join(d, 'bin'));
    writeFileSync(join(d, 'bin', 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    chmodTree(d, 'ro');
    expect(lstatSync(join(d, 'bin', 'tool')).mode & 0o777).toBe(0o555);
    expect(lstatSync(join(d, 'bin')).mode & 0o222).toBe(0);
    chmodTree(d, 'rw');
    expect(lstatSync(join(d, 'bin', 'tool')).mode & 0o200).toBe(0o200);
    expect(readdirSync(join(d, 'bin'))).toEqual(['tool']);
    chmodSync(d, 0o755);
  });
});
