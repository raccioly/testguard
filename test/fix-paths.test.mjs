import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseFixChangedPaths } from '../src/scaffold/fix-paths.mjs';

const before = 'a'.repeat(40), after = 'b'.repeat(40), zero = '0'.repeat(40);
const row = (file, status = 'M', oldMode = '100644', newMode = '100644', oldId = before, newId = after) => `:${oldMode} ${newMode} ${oldId} ${newId} ${status}\0${file}\0`;
const parse = (text, options) => parseFixChangedPaths(Buffer.from(text), options);
const roots = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('bounded raw fix path decoder', () => {
  it('decodes actual no-renames full-ID NUL raw diff output', () => {
    const root = mkdtempSync(join(tmpdir(), 'testguard-fix-paths-')); roots.push(root);
    const git = (...args) => {
      const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', `core.hooksPath=${devNull}`, ...args], { cwd: root });
      expect(result.status).toBe(0); return result.stdout;
    };
    git('init', '-q'); writeFileSync(join(root, 'guard.mjs'), 'export const x = 1;'); writeFileSync(join(root, 'old.py'), 'x = 1');
    git('add', '.'); git('commit', '-qm', 'Initial'); const parent = git('rev-parse', 'HEAD').toString().trim();
    writeFileSync(join(root, 'guard.mjs'), 'export const x = 2;'); unlinkSync(join(root, 'old.py')); writeFileSync(join(root, 'new.ts'), 'export const y = 1;');
    git('add', '-A'); git('commit', '-qm', 'Selected change'); const commit = git('rev-parse', 'HEAD').toString().trim();
    const raw = git('diff-tree', '--raw', '--no-abbrev', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '-r', '--no-commit-id', parent, commit, '--');
    let result; expect(() => { result = parseFixChangedPaths(raw); }).not.toThrow();
    expect(result.counts).toEqual({ total: 3, supported: 2, deleted: 1, unsupported: 0, excluded: 0 });
    expect(result.paths.map(r => [r.file, r.status])).toEqual([['guard.mjs', 'M'], ['new.ts', 'A'], ['old.py', 'D']]);
  });
  it('partitions all entries without exposing private names or inventing requirements', () => {
    let result;
    const raw = row('guard.mjs') + row('old.py', 'D', '100644', '000000', before, zero) + row('readme.md') + row('alias.mjs', 'T', '100644', '120000') + row('.local/private.mjs') + row('child/guard.py');
    expect(() => { result = parse(raw, { nestedProjects: ['child'] }); }).not.toThrow();
    expect(result.counts).toEqual({ total: 6, supported: 1, deleted: 1, unsupported: 2, excluded: 2 });
    expect(result.paths.map(r => [r.file, r.disposition])).toEqual([['guard.mjs', 'supported'], ['old.py', 'deleted'], ['readme.md', 'unsupported'], ['alias.mjs', 'unsupported']]);
    expect(JSON.stringify(result)).not.toContain('private'); expect(JSON.stringify(result)).not.toContain('child/');
    expect(result.claims).toBeUndefined(); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.paths)).toBe(true);
    expect(Object.isFrozen(result.counts)).toBe(true); expect(result.paths.every(Object.isFrozen)).toBe(true);
  });
  it('admits empty complete output and full-width added/executable source identities', () => {
    let empty, added;
    expect(() => { empty = parse(''); added = parse(row('guard.py', 'A', '000000', '100755', zero, after)); }).not.toThrow();
    expect(empty.counts.total).toBe(0); expect(added.counts.supported).toBe(1);
    expect(added.paths[0]).toMatchObject({ file: 'guard.py', status: 'A', oldId: zero, newId: after });
  });
  it('keeps SHA-256 IDs intact without mixing widths', () => {
    let result; expect(() => { result = parse(row('guard.ts', 'M', '100644', '100644', 'a'.repeat(64), 'b'.repeat(64))); }).not.toThrow();
    expect(result.paths[0].newId).toHaveLength(64);
    expect(() => parse(row('guard.ts', 'M', '100644', '100644', before, 'b'.repeat(64)))).toThrow(/malformed-record/);
  });
  it.each(['.local', '.wolf', '.git', '.testguard', 'graphify-out'])('counts but never exposes %s path components', directory => {
    let result; expect(() => { result = parse(row(`nested/${directory}/secret.mjs`)); }).not.toThrow();
    expect(result.paths).toEqual([]); expect(result.counts.excluded).toBe(1); expect(result.counts.total).toBe(1);
  });
  it.each(['../guard.mjs', '/guard.mjs', 'src/../guard.mjs', 'src/./guard.mjs', 'src\\guard.mjs', 'line\nbreak.mjs', ''])('refuses unsafe path %s', file => {
    expect(() => parse(row(file))).toThrow(/unsafe-path/);
  });
  it('refuses truncated, malformed, duplicate and inconsistent records', () => {
    expect(() => parse(row('guard.mjs').slice(0, -1))).toThrow(/truncated-output/);
    expect(() => parse('header\0')).toThrow(/malformed-record/);
    expect(() => parse(row('guard.mjs') + row('guard.mjs'))).toThrow(/duplicate-path/);
    expect(() => parse(row('guard.mjs', 'R100'))).toThrow(/malformed-record/);
    expect(() => parse(row('guard.mjs', 'A'))).toThrow(/inconsistent-identity/);
    expect(() => parse(row('guard.mjs', 'D'))).toThrow(/inconsistent-identity/);
    expect(() => parse(row('guard.mjs', 'M', '000000', '100644', zero, after))).toThrow(/inconsistent-identity/);
  });
  it('refuses limits and malformed UTF-8 instead of returning a truncated partition', () => {
    expect(() => parseFixChangedPaths('')).toThrow(/buffer-required/);
    expect(() => parseFixChangedPaths(Buffer.alloc(128 * 1024 + 1))).toThrow(/output-byte-limit/);
    expect(() => parseFixChangedPaths(Buffer.from([0xff, 0]))).toThrow(/invalid-utf8/);
    expect(() => parse(Array.from({ length: 257 }, (_, i) => row(`f${i}.mjs`)).join(''))).toThrow(/path-count-limit/);
    expect(() => parse(row(`${'x'.repeat(4096)}.mjs`))).toThrow(/path-byte-limit/);
    expect(() => parse('', { nestedProjects: ['../child'] })).toThrow(/unsafe-path/);
    expect(() => parse('', { nestedProjects: Array.from({ length: 257 }, (_, i) => `p${i}`) })).toThrow(/project-count-limit/);
  });
});
