// @req NFR-01
// #331: init on a project whose source TestGuard cannot probe says so up front,
// instead of leaving the first hint to a refused probe. It writes the same files
// and the same exit code as before.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { initProject } from '../src/init/init.mjs';

const dirs = [];
const project = (files) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-lang-')));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) { mkdirSync(join(dirname(join(dir, rel))), { recursive: true }); writeFileSync(join(dir, rel), text); }
  return dir;
};
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const APEX = {
  'sfdx-project.json': '{ "packageDirectories": [{ "path": "force-app", "default": true }] }',
  'force-app/main/default/classes/DiscountService.cls': 'public with sharing class DiscountService {}\n',
  'force-app/main/default/classes/PriceService.cls': 'public with sharing class PriceService {}\n',
};

describe('init — source in a language TestGuard cannot probe yet (#331)', () => {
  it('notes the language and the file count when no probeable source exists', () => {
    const r = initProject({ projectDir: project(APEX), here: true });
    const note = r.notes.find((n) => /cannot probe Apex/.test(n));
    expect(note).toBeDefined();
    expect(note).toMatch(/2 Apex files/);
    expect(note).toMatch(/declare defendedBy/);
  });

  it('is a note: no warning, so the exit code and the written files are those of a plain init', () => {
    const plain = initProject({ projectDir: project({ 'README.md': '# x\n' }), here: true });
    const apex = initProject({ projectDir: project(APEX), here: true });
    expect(apex.warnings).toEqual(plain.warnings);
    expect(apex.done).toEqual(plain.done);
  });

  it('stays silent when the project has probeable source', () => {
    const r = initProject({ projectDir: project({ ...APEX, 'src/a.mjs': 'export const a = 1;\n' }), here: true });
    expect(r.notes.join('\n')).not.toMatch(/cannot probe/);
  });

  it('stays silent when there is no source in a known language at all', () => {
    const r = initProject({ projectDir: project({ 'README.md': '# x\n' }), here: true });
    expect(r.notes.join('\n')).not.toMatch(/cannot probe/);
  });

  it('names every language, counts first', () => {
    const r = initProject({ projectDir: project({ ...APEX, 'src/main/java/demo/A.java': 'class A {}\n' }), here: true });
    const note = r.notes.find((n) => /cannot probe/.test(n));
    expect(note).toMatch(/Apex/);
    expect(note).toMatch(/Java/);
  });
});
