// #301 item 8: a CommonJS export form the reader does not model
// (`module.exports = Reporter`) once made the whole import closure
// indeterminate, so `probe --changed` selected that claim for any change in
// the repository, a documentation-only one included. Such a form can hide
// which binding an importer receives, never which file loads: the closure
// scans every literal require() itself. These hold both halves.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createDependencyHasher } from '../src/probe/dependencies.mjs';
import { parseModuleSource } from '../src/probe/imports.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const project = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'tg-cjs-surface-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
};
const closureOf = (root, file) => createDependencyHasher(root, { cache: false, untracked: true }).inputsFor([file]);

describe('a CommonJS export form the reader does not model', () => {
  it('leaves the file closure complete, with every file it requires', () => {
    const root = project({
      'reporter.cjs': "const { helper } = require('./helper.cjs');\nclass Reporter { run() { return helper(); } }\nmodule.exports = Reporter;\n",
      'helper.cjs': 'exports.helper = () => 1;\n',
    });
    const r = closureOf(root, 'reporter.cjs');
    expect(r.dependencyClosure).toBe('complete');
    expect(Object.keys(r.dependencyHashes)).toEqual(expect.arrayContaining(['reporter.cjs', 'helper.cjs']));
  });

  it('a computed export write still follows its literal require', () => {
    const root = project({
      'index.cjs': "const name = 'x';\nexports[name] = require('./value.cjs');\n",
      'value.cjs': 'module.exports = 1;\n',
    });
    const r = closureOf(root, 'index.cjs');
    expect(r.dependencyClosure).toBe('complete');
    expect(Object.keys(r.dependencyHashes)).toContain('value.cjs');
  });

  it('stays uncertain for binding resolution: which name an importer receives is still unknown', () => {
    const parsed = parseModuleSource('class Reporter {}\nmodule.exports = Reporter;\n');
    expect(parsed.uncertain).toEqual(['unsupported-syntax']);
    expect(parsed.fileUncertain).toEqual([]);
  });

  it('what can hide a file is still indeterminate: a computed require, an unreadable import form', () => {
    const computed = project({ 'a.cjs': "const n = './b.cjs';\nmodule.exports = require(n);\n", 'b.cjs': '' });
    expect(closureOf(computed, 'a.cjs').dependencyClosure).toBe('indeterminate');
    const destructured = parseModuleSource("const { [key]: value } = require('./b.cjs');\n");
    expect(destructured.fileUncertain).toEqual(['unsupported-syntax']);
  });
});
