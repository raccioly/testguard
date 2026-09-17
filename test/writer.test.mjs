import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSpecDoc, readSpecDoc, SpecDocError } from '../src/evidence/writer.mjs';

const dir = mkdtempSync(join(tmpdir(), 'tg-writer-'));
const valid = JSON.parse(readFileSync(new URL('../spec/conformance/examples/baseline.json', import.meta.url), 'utf8'));

describe('writeSpecDoc', () => {
  it('writes a conforming document', () => {
    const p = join(dir, 'ok', 'baseline.json');
    writeSpecDoc('baseline', p, valid);
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual(valid);
  });

  it('refuses a non-conforming document and writes nothing', () => {
    const p = join(dir, 'bad', 'baseline.json');
    const bad = { ...valid, fingerprints: { 'not-a-hash': 1 } };
    expect(() => writeSpecDoc('baseline', p, bad)).toThrow(SpecDocError);
    expect(existsSync(p)).toBe(false);
  });

  it('refuses a document that fails a semantic rule, not just the schema', () => {
    const p = join(dir, 'semantic', 'calibration.json');
    const cal = JSON.parse(readFileSync(new URL('../spec/conformance/examples/calibration.json', import.meta.url), 'utf8'));
    cal.buckets['guard-removed'].positives = cal.buckets['guard-removed'].n + 1;
    expect(() => writeSpecDoc('calibration', p, cal)).toThrow(/positives/);
    expect(existsSync(p)).toBe(false);
  });
});

describe('readSpecDoc', () => {
  it('refuses a non-conforming document on disk', () => {
    const p = join(dir, 'tampered.json');
    writeFileSync(p, JSON.stringify({ ...valid, fingerprints: { ['a'.repeat(64)]: 0 } }));
    expect(() => readSpecDoc('baseline', p)).toThrow(SpecDocError);
  });
  it('refuses unreadable JSON with the path in the message', () => {
    const p = join(dir, 'garbage.json');
    writeFileSync(p, '{not json');
    expect(() => readSpecDoc('baseline', p)).toThrow(/garbage\.json/);
  });
});
