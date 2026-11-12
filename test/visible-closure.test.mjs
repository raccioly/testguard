// Issue #272: a closure describes the tree that will be probed. The working
// tree may hold an ignored build directory with copies of third-party
// packages; indexed as project modules they made every Python closure
// indeterminate, so `probe --changed` selected every claim for a docs-only
// change while the scratch tree (a checkout of the commit) saw complete
// closures. Only files git tracks (plus untracked, non-ignored files under
// --include-dirty) are project files; ignored directories never are.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createDependencyHasher } from '../src/probe/dependencies.mjs';
import { resolveProbeScope } from '../src/probe/scope.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { commit, git } from './helpers/scope-project.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const by = { producer: 'agent', by: 'fixture' };
const claim = (id, file, defender, find, replace) => ({
  id, statement: `${id} holds.`, source: { kind: 'spec', ref: 'README.md' }, severity: 'high', producedBy: by, defendedBy: [defender],
  faults: [{ id: 'F1', description: 'Break it.', faultClass: 'return-altered', file, find, replace, producedBy: by }],
});
const write = (root, files) => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
};
const CLAIMS = {
  schemaVersion: 1,
  claims: [
    claim('CORE', 'app/core.py', 'tests/test_core.py', 'return n * 2', 'return n * 3'),
    claim('OTHER', 'app/other.py', 'tests/test_other.py', 'return n + 1', 'return n + 2'),
    claim('PRICE', 'src/price.mjs', 'test/price.test.mjs', 'a + b', 'a - b'),
  ],
};
/** A repository whose working tree holds an ignored deployment bundle with third-party copies. */
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-visible-')));
  roots.push(root);
  write(root, {
    'README.md': '# fixture\n',
    '.gitignore': 'deploy-bundle/\n',
    'package.json': JSON.stringify({ name: 'visible', private: true, type: 'module', imports: { '#vendor/*': './deploy-bundle/*' } }),
    'app/__init__.py': '',
    'app/core.py': 'import pydantic\nimport anyio\n\ndef double(n):\n    return n * 2\n',
    'app/other.py': 'def inc(n):\n    return n + 1\n',
    'tests/test_core.py': 'from app.core import double\n\ndef test_double():\n    assert double(2) == 4\n',
    'tests/test_other.py': 'from app.other import inc\n\ndef test_inc():\n    assert inc(1) == 2\n',
    'src/price.mjs': "import { round } from './round.mjs';\nexport const total = (a, b) => round(a + b);\n",
    'src/round.mjs': 'export const round = (n) => Math.round(n);\n',
    'test/price.test.mjs': "import { total } from '../src/price.mjs';\n",
    'src/vendored.mjs': "import { round } from '#vendor/round.mjs';\nexport const v = round(1);\n",
    'tests/test_obsolete.py': 'def test_old():\n    assert True\n',
  });
  const base = commit_(root);
  // Untracked AND ignored: a build output with copies of dependencies, one with a computed import.
  write(root, {
    'deploy-bundle/pydantic/__init__.py': 'import importlib\nplugin = importlib.import_module(name)\n',
    'deploy-bundle/anyio/__init__.py': 'from ._backends import run\n',
    'deploy-bundle/round.mjs': 'export const round = (n) => Math.round(n);\n',
  });
  return { root, base };
}
function commit_(root) {
  git(root, 'init', '-q', '-b', 'main');
  return commit(root, 'base');
}
const inputs = (dir, roots) => createDependencyHasher(dir, { cache: false }).inputsFor(roots);

describe('the closure ignores what git ignores', () => {
  it('is the same in the working tree as in a clean checkout of the commit', () => {
    const { root } = repo();
    const checkout = join(realpathSync(mkdtempSync(join(tmpdir(), 'tg-visible-co-'))), 'co');
    roots.push(dirname(checkout));
    git(root, 'worktree', 'add', '-q', '--detach', checkout, 'HEAD');
    for (const set of [['app/core.py', 'tests/test_core.py'], ['src/price.mjs', 'test/price.test.mjs']]) {
      const here = inputs(root, set);
      expect(here.dependencyClosure, set[0]).toBe('complete');
      expect(here, set[0]).toEqual(inputs(checkout, set));
      expect(Object.keys(here.dependencyHashes).some((file) => file.startsWith('deploy-bundle/')), set[0]).toBe(false);
    }
    // A JavaScript import into the ignored copy: the checkout cannot load it,
    // so neither tree may call the closure complete (or hash the copy).
    const vendored = inputs(root, ['src/vendored.mjs']);
    expect(vendored).toEqual(inputs(checkout, ['src/vendored.mjs']));
    expect(vendored.dependencyClosure).toBe('indeterminate');
  });

  it('a docs-only change selects nothing, and a source change selects only its claim, with the reason', () => {
    const { root, base } = repo();
    writeFileSync(join(root, 'README.md'), '# fixture, edited\n');
    commit(root);
    const docs = resolveProbeScope({ projectDir: root, claims: CLAIMS, ref: base });
    expect(docs).toMatchObject({ outcome: 'determined', selected: [], matchedClaims: [], matchReasons: [] });
    writeFileSync(join(root, 'app/other.py'), 'def inc(n):\n    return n + 1  # edited\n');
    const next = commit(root);
    const scope = resolveProbeScope({ projectDir: root, claims: CLAIMS, ref: `${next}~1` });
    expect(scope.selected).toEqual(['OTHER']);
    expect(scope.matchReasons).toEqual([{ claimId: 'OTHER', kind: 'file', file: 'app/other.py' }]);
  });

  it('an untracked, non-ignored file is a project file only under --include-dirty', () => {
    const { root } = repo();
    // Committed: price imports ./extra.mjs; extra.mjs itself is left untracked (not ignored).
    write(root, { 'src/price.mjs': "import { round } from './round.mjs';\nimport { extra } from './extra.mjs';\nexport const total = (a, b) => round(a + b) + extra;\n" });
    commit(root);
    writeFileSync(join(root, 'README.md'), 'docs\n');
    const head = commit(root);
    write(root, { 'src/extra.mjs': 'export const extra = 0;\n' });
    // The commit alone cannot load ./extra.mjs, which is what the scratch tree will hold.
    const clean = resolveProbeScope({ projectDir: root, claims: CLAIMS, ref: `${head}~1` });
    expect(clean.matchReasons).toEqual([{ claimId: 'PRICE', kind: 'indeterminate', issue: { code: 'unreadable-module', file: 'src/price.mjs', specifier: './extra.mjs' } }]);
    // Snapshotting the working tree includes it: a changed (untracked) file in PRICE's closure.
    const dirty = resolveProbeScope({ projectDir: root, claims: CLAIMS, ref: `${head}~1`, includeDirty: true });
    expect(dirty.matchReasons).toEqual([{ claimId: 'PRICE', kind: 'file', file: 'src/extra.mjs' }]);
    // Untracked counts, ignored never: the bundle's pydantic copy stays out.
    const withUntracked = createDependencyHasher(root, { cache: false, untracked: true }).inputsFor(['app/core.py', 'tests/test_core.py']);
    expect(withUntracked.dependencyClosure).toBe('complete');
    expect(Object.keys(withUntracked.dependencyHashes).some((file) => file.startsWith('deploy-bundle/'))).toBe(false);
  });
});

describe('run.scope.changed says why each claim was selected', () => {
  it('names a glob, and an indeterminate closure with its first issue', () => {
    const { root, base } = repo();
    const claims = structuredClone(CLAIMS);
    claims.claims[1].defendedBy = ['tests/test_o*.py'];
    write(root, { 'app/core.py': 'import importlib\nmod = importlib.import_module(name)\n\ndef double(n):\n    return n * 2\n' });
    rmSync(join(root, 'tests/test_obsolete.py'));
    commit(root);
    const scope = resolveProbeScope({ projectDir: root, claims, ref: base });
    const why = Object.fromEntries(scope.matchReasons.map((r) => [r.claimId, r]));
    expect(why.CORE).toEqual({ claimId: 'CORE', kind: 'file', file: 'app/core.py' });
    expect(why.OTHER).toEqual({ claimId: 'OTHER', kind: 'glob', file: 'tests/test_obsolete.py', glob: 'tests/test_o*.py' });
    // PRICE is untouched and complete: not selected.
    expect(why.PRICE).toBeUndefined();
    writeFileSync(join(root, 'README.md'), 'x\n');
    const head = commit(root);
    const indeterminate = resolveProbeScope({ projectDir: root, claims, ref: `${head}~1` });
    expect(indeterminate.matchReasons).toEqual([{ claimId: 'CORE', kind: 'indeterminate', issue: { code: 'computed-specifier', file: 'app/core.py' } }]);
  });

  it('the reasons are part of the status document and agree with matchedClaims', () => {
    const doc = example();
    expect(doc.run.scope.changed.matchReasons.map((r) => r.claimId)).toEqual(doc.run.scope.changed.matchedClaims);
    expect(validate('status', doc).errors).toEqual([]);
    const swapped = example();
    swapped.run.scope.changed.matchReasons[0].claimId = 'REDACT-003';
    expect(validate('status', swapped).errors.map((e) => e.message).join('\n')).toMatch(/matchReasons/);
    const notChanged = example();
    notChanged.run.scope.changed.matchReasons[0].file = 'src/elsewhere.mjs';
    expect(validate('status', notChanged).errors.map((e) => e.path)).toContain('/run/scope/changed/matchReasons/0/file');
  });
});

function example() {
  return JSON.parse(readFileSync(new URL('../spec/conformance/examples/status-scoped-run.json', import.meta.url), 'utf8'));
}
