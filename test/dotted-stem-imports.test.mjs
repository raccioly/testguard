// #301: a specifier whose last segment contains a dot (`./auth.config`) names a file whose dot is part
// of its name. The import closure must follow it, or every claim through that file is indeterminate
// and selected by every `--changed` run.
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImportResolver } from '../src/probe/imports.mjs';
import { fileImports, resetAliasCache } from '../src/probe/rank.mjs';
import { resolveProbeScope } from '../src/probe/scope.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { commit, git } from './helpers/scope-project.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'dotted-stem');
const projects = [];
const project = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'tg-dotted-'));
  projects.push(root);
  for (const [name, source] of Object.entries(files)) { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), source); }
  return root;
};
afterEach(() => { while (projects.length) rmSync(projects.pop(), { recursive: true, force: true }); resetAliasCache(); });
const closure = (root, file) => createImportResolver(root).closure([join(root, file)]);

describe('a dotted stem resolves like any other module', () => {
  it('`./auth.config` is src/auth.config.ts, and `./auth.config/index` style directories resolve too', () => {
    const root = project({ 'src/a.ts': "import { c } from './auth.config';\n", 'src/auth.config.ts': 'export const c = 1;\n' });
    expect(closure(root, 'src/a.ts')).toEqual({ status: 'complete', files: ['src/a.ts', 'src/auth.config.ts'] });
    const dir = project({ 'src/a.ts': "import { c } from './auth.config';\n", 'src/auth.config/index.ts': 'export const c = 1;\n' });
    expect(closure(dir, 'src/a.ts')).toEqual({ status: 'complete', files: ['src/a.ts', 'src/auth.config/index.ts'] });
  });

  it('an exact file still wins: `./data.json` is data.json, never data.json.ts', () => {
    const root = project({ 'src/a.ts': "import d from './data.json';\n", 'src/data.json': '{}', 'src/data.json.ts': 'export default 1;\n' });
    expect(closure(root, 'src/a.ts').files).toEqual(['src/a.ts', 'src/data.json']);
  });

  it('`./x.js` still falls back to x.ts', () => {
    const root = project({ 'src/a.ts': "import { x } from './x.js';\n", 'src/x.ts': 'export const x = 1;\n' });
    expect(closure(root, 'src/a.ts')).toEqual({ status: 'complete', files: ['src/a.ts', 'src/x.ts'] });
  });

  it('a truly missing `./gone.config` is still unreadable-module', () => {
    const root = project({ 'src/a.ts': "import { g } from './gone.config';\n" });
    expect(closure(root, 'src/a.ts')).toMatchObject({ status: 'indeterminate', issues: [{ code: 'unreadable-module', file: 'src/a.ts', specifier: './gone.config' }] });
  });

  it('the ranking resolver agrees on the same four cases', () => {
    const root = project({ 'src/a.ts': "import { c } from './auth.config';\nimport d from './data.json';\nimport { x } from './x.js';\n", 'src/auth.config.ts': '', 'src/data.json': '{}', 'src/x.ts': '' });
    expect(fileImports(root, join(root, 'src/a.ts'), 'src/auth.config.ts')).toBe(true);
    expect(fileImports(root, join(root, 'src/a.ts'), 'src/data.json')).toBe(true);
    expect(fileImports(root, join(root, 'src/a.ts'), 'src/x.ts')).toBe(true);
    expect(fileImports(root, join(root, 'src/a.ts'), 'src/gone.config.ts')).toBe(false);
  });
});

describe('the dotted-stem fixture', () => {
  it('a docs-only change selects no claim; a change to the dotted file selects its claim', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-dotted-fixture-'));
    projects.push(root);
    cpSync(FIXTURE, root, { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    const base = commit(root, 'base');
    writeFileSync(join(root, 'README.md'), '# edited\n');
    commit(root);
    const claims = loadClaims(join(root, 'testguard.claims.json'));
    expect(resolveProbeScope({ projectDir: root, claims, ref: base })).toMatchObject({ outcome: 'determined', selected: [], matchReasons: [] });
    writeFileSync(join(root, 'src/auth.config.ts'), 'export const authConfig = { sessionSeconds: 7200 };\n');
    const next = commit(root);
    expect(resolveProbeScope({ projectDir: root, claims, ref: `${next}~1` }).selected).toEqual(['SESSION-001']);
  });
});
