// Issue #330: tsconfig/jsconfig are JSONC, and `tsc` accepts comments and
// trailing commas. Discovery crashed on them (strict JSON.parse) and the alias
// reader dropped every `paths` alias when a glob such as "src/**/*.ts" sat in
// the file (a comment regex that also matched inside strings). One tolerant,
// string-aware parser now serves both readers.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonc } from '../src/util/jsonc.mjs';
import { hashDiscoveryConfigs } from '../src/probe/runners/discovery.mjs';
import { loadAliases, resetAliasCache } from '../src/probe/rank.mjs';

describe('parseJsonc', () => {
  it('skips a line comment', () => {
    expect(parseJsonc('{\n // note\n "a": 1 // tail\n}')).toEqual({ a: 1 });
  });
  it('skips a block comment, including a header before the root value', () => {
    expect(parseJsonc('/* To learn more ... */\n{ /* mid */ "a": /* x */ 1 }')).toEqual({ a: 1 });
  });
  it('accepts a trailing comma in objects and arrays', () => {
    expect(parseJsonc('{ "a": [1, 2,], "b": { "c": 3, }, }')).toEqual({ a: [1, 2], b: { c: 3 } });
  });
  it('keeps a comment-looking sequence inside a string', () => {
    expect(parseJsonc('{ "include": ["src/**/*.ts"] }')).toEqual({ include: ['src/**/*.ts'] });
    expect(parseJsonc('{ "u": "https://example.test/a" }')).toEqual({ u: 'https://example.test/a' });
    expect(parseJsonc('{ "s": "a, ]" , "t": "x\\"//y" }')).toEqual({ s: 'a, ]', t: 'x"//y' });
  });
  it('keeps a comma-then-bracket sequence inside a string', () => {
    expect(parseJsonc('{ "a": ",}", }')).toEqual({ a: ',}' });
  });
  it('ignores a byte order mark', () => {
    expect(parseJsonc('﻿{ "a": 1 }')).toEqual({ a: 1 });
  });
  it('still rejects invalid JSON with the JSON.parse message shape', () => {
    expect(() => parseJsonc('{ "a": }')).toThrow(SyntaxError);
    let strict; try { JSON.parse('{ "a": }'); } catch (e) { strict = e.message; }
    let loose; try { parseJsonc('{ "a": }'); } catch (e) { loose = e.message; }
    expect(loose).toBe(strict);
  });
  it('rejects a single quoted string and an unterminated block comment', () => {
    expect(() => parseJsonc("{ 'a': 1 }")).toThrow(SyntaxError);
    expect(() => parseJsonc('{ "a": 1 } /* open')).toThrow(SyntaxError);
  });
});

describe('both tsconfig readers use it', () => {
  const dirs = [];
  afterEach(() => { resetAliasCache(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const project = (tsconfig) => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-jsonc-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'tsconfig.json'), tsconfig);
    return dir;
  };

  it('discovery hashes a tsconfig that has a header comment and a trailing comma', () => {
    const dir = project('/* header */\n{ "compilerOptions": { "strict": true, }, }\n');
    expect(() => hashDiscoveryConfigs(dir, ['tsconfig.json'])).not.toThrow();
  });

  it('the alias reader keeps `paths` when an include glob holds /**/', () => {
    const dir = project('{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"] } }, "include": ["src/**/*.ts"] }');
    expect(JSON.stringify(loadAliases(dir))).toContain('@app/');
  });
});
