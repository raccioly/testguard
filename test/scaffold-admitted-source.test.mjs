import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldFile } from '../src/scaffold/scaffold.mjs';
import { validate } from '../spec/lib/validate.mjs';
import * as jsProducers from '../src/scaffold/producers.mjs';
import * as pyProducers from '../src/scaffold/producers.python.mjs';

const roots = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'testguard-admitted-source-')); roots.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
const js = 'export function guard(x) {\n  if (!x) throw new Error("absent");\n}\n';
const python = 'def guard(x):\n    if not x:\n        raise ValueError("absent")\n';
const scan = (source, extra = {}) => scaffoldFile({ projectDir: root(), file: 'guard.mjs', source, ...extra });

describe('scaffold consumes admitted source without rereading it', () => {
  it.each([['guard.mjs', js], ['guard.py', python]])('scans supplied bytes for %s even without a disk target', (file, source) => {
    let result;
    expect(() => { result = scan(source, { file, maxProposals: 10 }); }).not.toThrow();
    expect(validate('claims', result.doc).ok).toBe(true);
    expect(result.stats.proposals).toBeGreaterThan(0);
    expect(result.doc.claims.flatMap((claim) => claim.faults).every((fault) => source.includes(fault.find))).toBe(true);
  });

  it('accepts empty admitted source without falling back to disk', () => {
    let result;
    expect(() => { result = scan('', { maxProposals: 0 }); }).not.toThrow();
    expect(result.stats.proposals).toBe(0);
    expect(result.doc.claims).toEqual([]);
  });

  it.each([['guard.mjs', js], ['guard.py', python]])('refuses excess proposals for %s, never returns a truncated draft', (file, source) => {
    expect(() => scan(source, { file, maxProposals: 0 })).toThrow(/proposal limit/);
    let complete;
    expect(() => { complete = scan(source, { file }); }).not.toThrow();
    const count = complete.stats.proposals;
    expect(count).toBeGreaterThan(0);
    expect(() => scan(source, { file, maxProposals: count - 1 })).toThrow(/proposal limit/);
    expect(scan(source, { file, maxProposals: count }).doc).toEqual(complete.doc);
  });

  it.each([-1, 0.5, NaN, Infinity, '1', null])('rejects invalid explicit limit %s before disk access', (maxProposals) => {
    expect(() => scaffoldFile({ projectDir: root(), file: 'missing.mjs', maxProposals })).toThrow(/maxProposals/);
  });

  it.each([['guard.mjs', js, jsProducers], ['guard.py', python, pyProducers]])('stops %s generation at the limit, before scanning the remaining source', (file, source, producers) => {
    const calls = vi.spyOn(producers, 'proposalsForLine');
    expect(() => scan(source.repeat(100), { file, maxProposals: 0 })).toThrow(/proposal limit/);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it.each([null, 123, {}])('rejects invalid admitted source %s instead of rereading disk', (source) => {
    expect(() => scan(source)).toThrow(/source must be a string/);
  });
});
