// Issue #232 (8): a run killed mid-write must not leave a truncated evidence
// file that the next probe reads as its prior evidence.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const failWrites = { on: false };
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal();
  return {
    ...fs,
    writeFileSync: (path, data, options) => {
      if (failWrites.on && String(path).includes('.tmp')) {
        // A crash partway through: half the bytes reach the disk, then the write dies.
        fs.writeFileSync(path, String(data).slice(0, String(data).length >> 1), options);
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return fs.writeFileSync(path, data, options);
    },
  };
});

const { writeSpecDoc, readSpecDoc } = await import('../src/evidence/writer.mjs');
const example = JSON.parse(readFileSync(new URL('../spec/conformance/examples/evidence.json', import.meta.url), 'utf8'));

const dirs = [];
afterEach(() => { failWrites.on = false; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('evidence is written atomically', () => {
  it('replaces the previous document whole and leaves no temporary file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-atomic-')); dirs.push(dir);
    const path = join(dir, 'evidence.json');
    writeFileSync(path, 'previous');
    writeSpecDoc('evidence', path, example);
    expect(readSpecDoc('evidence', path)).toEqual(example);
    expect(readdirSync(dir)).toEqual(['evidence.json']);
  });

  it('a write that dies partway leaves the previous document intact and no temporary file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-atomic-')); dirs.push(dir);
    const path = join(dir, 'evidence.json');
    writeSpecDoc('evidence', path, example);
    const before = readFileSync(path, 'utf8');
    failWrites.on = true;
    const changed = { ...structuredClone(example), run: { ...example.run, id: 'run-20260918-020000' } };
    expect(() => writeSpecDoc('evidence', path, changed)).toThrow(/ENOSPC/);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['evidence.json']);
  });
});
