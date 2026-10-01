import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectAnnotationAdvisory } from '../src/claims/annotations.mjs';

const io = vi.hoisted(() => ({ virtualRoot: '', staleSize: '', descriptors: new Map(), reads: [], directoryClosed: false }));
vi.mock('node:fs', async (original) => {
  const fs = await original();
  return { ...fs,
    opendirSync: (path, ...args) => {
      if (path !== io.virtualRoot) return fs.opendirSync(path, ...args);
      let count = 0;
      return {
        readSync: () => ++count <= 10001 ? { name: `ignored-${count}.txt`, isDirectory: () => false, isFile: () => true } : null,
        closeSync: () => { io.directoryClosed = true; },
      };
    },
    openSync: (path, ...args) => { const fd = fs.openSync(path, ...args); io.descriptors.set(fd, path); return fd; },
    fstatSync: (fd, ...args) => {
      const stat = fs.fstatSync(fd, ...args);
      return io.descriptors.get(fd) === io.staleSize ? { ...stat, size: 0, isFile: () => stat.isFile() } : stat;
    },
    readSync: (fd, ...args) => {
      const n = fs.readSync(fd, ...args); io.reads.push({ path: io.descriptors.get(fd), n, requested: args[2] }); return n;
    },
  };
});
const roots = [];
afterEach(() => {
  io.virtualRoot = ''; io.staleSize = ''; io.descriptors.clear(); io.reads.length = 0; io.directoryClosed = false;
  roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function root() { const dir = mkdtempSync(join(tmpdir(), 'tg-advice-limits-')); roots.push(dir); return dir; }
const claims = { claims: [{ id: 'A-1' }] };
function unavailable(dir) {
  const advice = projectAnnotationAdvisory(dir, claims);
  expect(advice.missingIds).toEqual([]);
  expect(advice.notes.join('\n')).toContain('ANNOTATION ADVISORY unavailable');
  expect(advice.notes.join('\n')).not.toContain('Missing source annotation:');
}
describe('annotation advisory resource admission', () => {
  it('charges actual aggregate bytes across individually admissible files', () => {
    const dir = root();
    for (let i = 0; i < 11; i++) writeFileSync(join(dir, `source-${i}.md`), 'x'.repeat(200 * 1024));
    unavailable(dir);
    expect(io.reads.reduce((total, r) => total + r.n, 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
  it('stops after the source-file count ceiling', () => {
    const dir = root();
    for (let i = 0; i < 1001; i++) writeFileSync(join(dir, `source-${i}.md`), '');
    unavailable(dir);
    expect(io.descriptors.size).toBeLessThanOrEqual(1000);
  });
  it('counts even excluded directory entries and closes the enumerator on refusal', () => {
    const dir = root(); io.virtualRoot = dir;
    // Controlled metadata stream, not 10,001 physical fixture files.
    unavailable(dir);
    expect(io.directoryClosed).toBe(true);
    expect(io.reads).toEqual([]);
  });
  it('refuses excessive directory depth without claiming links are absent', () => {
    const dir = root(); let current = dir;
    for (let i = 0; i < 65; i++) { current = join(current, 'd'); mkdirSync(current); }
    unavailable(dir);
  });
  it('caps real descriptor bytes even when the observed size is stale', () => {
    const dir = root(); const path = join(dir, 'growing.md');
    writeFileSync(path, 'x'.repeat(256 * 1024 + 1)); io.staleSize = path;
    unavailable(dir);
    const reads = io.reads.filter((r) => r.path === path);
    expect(reads.reduce((total, r) => total + r.n, 0)).toBe(256 * 1024 + 1);
    expect(Math.max(...reads.map((r) => r.requested))).toBeLessThanOrEqual(256 * 1024 + 1);
  });
});
