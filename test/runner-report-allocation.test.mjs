// @req FR-10
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readBoundedJsonFile } from '../src/probe/runners/discovery.mjs';

const race = vi.hoisted(() => ({ afterStat: undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal();
  return { ...fs, fstatSync: (...args) => {
    const stat = fs.fstatSync(...args);
    const change = race.afterStat;
    race.afterStat = undefined;
    change?.();
    return stat;
  } };
});

const dirs = [];
const reportFile = (text) => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-report-allocation-'));
  dirs.push(dir);
  const path = join(dir, 'report.json');
  writeFileSync(path, text);
  return path;
};
afterEach(() => {
  race.afterStat = undefined;
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('bounded report allocation', () => {
  it('can read a tiny report under a large byte ceiling without reserving the ceiling', () => {
    const path = reportFile('{"cases":[]}');
    const alloc = Buffer.alloc;
    const sizes = [];
    vi.spyOn(Buffer, 'alloc').mockImplementation((size, ...args) => {
      sizes.push(size);
      if (size > 1024) throw new Error('tiny report exceeded its memory allowance');
      return alloc(size, ...args);
    });
    expect(readBoundedJsonFile(path, 1024 * 1024 * 1024)).toEqual({ cases: [] });
    expect(sizes.length).toBeGreaterThan(0);
  });

  it('reads growth after the size snapshot instead of accepting a valid truncated prefix', () => {
    const path = reportFile('{}');
    race.afterStat = () => appendFileSync(path, 'x');
    expect(() => readBoundedJsonFile(path, 32)).toThrow(/not valid JSON/);
  });

  it('can grow repeatedly to complete a report within the byte ceiling', () => {
    const text = JSON.stringify({ text: 'x'.repeat(20_000) });
    const path = reportFile(text.slice(0, 2));
    race.afterStat = () => appendFileSync(path, text.slice(2));
    expect(readBoundedJsonFile(path, Buffer.byteLength(text))).toEqual({ text: 'x'.repeat(20_000) });
  });

  it('rejects growth beyond the ceiling even when its initial prefix was valid JSON', () => {
    const path = reportFile('{}');
    race.afterStat = () => appendFileSync(path, ' '.repeat(100));
    expect(() => readBoundedJsonFile(path, 16)).toThrow(/exceeded 16 bytes/);
  });

  it('keeps exact-byte, empty, UTF-8 and regular-file boundaries', () => {
    const text = '{"text":"é"}';
    const path = reportFile(text);
    expect(readBoundedJsonFile(path, Buffer.byteLength(text))).toEqual({ text: 'é' });
    expect(() => readBoundedJsonFile(path, Buffer.byteLength(text) - 1)).toThrow(/exceeded/);
    writeFileSync(path, '');
    expect(() => readBoundedJsonFile(path)).toThrow(/not valid JSON/);
    writeFileSync(path, Buffer.from([0xff]));
    expect(() => readBoundedJsonFile(path)).toThrow(/UTF-8/);
    const link = join(dirs.at(-1), 'link.json');
    symlinkSync(path, link);
    expect(() => readBoundedJsonFile(link)).toThrow(/not readable/);
    expect(() => readBoundedJsonFile(dirs.at(-1))).toThrow(/not a regular file/);
  });
});
