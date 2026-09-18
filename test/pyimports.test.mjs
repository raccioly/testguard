import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pyModuleName, pyImports, pyFileImports, pyBlastRadius, pyPatches, analyzePyDefender, IS_PY_TEST } from '../src/probe/pyimports.mjs';
import { classifyDefenders } from '../src/probe/mocks.mjs';
import { discoverDefenders, discoverDefendersDetailed } from '../src/probe/discover.mjs';

let dir;
const write = (rel, text) => {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
};
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tg-py-')); });

describe('a file is matched by its module name, because that is what Python matches on', () => {
  it('walks up while each directory is a package', () => {
    write('src/pkg/__init__.py', '');
    write('src/pkg/mod.py', '');
    expect(pyModuleName(dir, 'src/pkg/mod.py')).toEqual({ dotted: 'pkg.mod', isPackage: false });
  });
  it('a package is its own __init__.py, which is why `import pkg.anything` reaches it', () => {
    write('pkg/__init__.py', '');
    expect(pyModuleName(dir, 'pkg/__init__.py')).toEqual({ dotted: 'pkg', isPackage: true });
  });
  it('a module outside any package is its bare name', () => {
    write('mod.py', '');
    expect(pyModuleName(dir, 'mod.py')).toEqual({ dotted: 'mod', isPackage: false });
  });
});

describe('import forms', () => {
  it('reads plain, aliased, from-, star- and relative imports', () => {
    const found = pyImports([
      'import os',
      'import pkg.mod as m, other.thing',
      'from pkg.mod import fn, other as o',
      'from pkg import mod',
      'from . import sibling',
      'from ..up.deep import thing',
      'from pkg.star import *',
    ].join('\n'), 'tests.unit');
    expect(found).toContain('pkg.mod');
    expect(found).toContain('pkg.mod.fn');
    expect(found).toContain('other.thing');
    expect(found).toContain('tests.unit.sibling');
    expect(found).toContain('tests.up.deep');
    expect(found).toContain('pkg.star');
  });

  it('`from pkg import mod` records both readings, because the import site cannot tell them apart', () => {
    const found = pyImports('from pkg import mod\n');
    expect(found).toEqual(expect.arrayContaining(['pkg', 'pkg.mod']));
  });

  it('joins a parenthesised list and a backslash continuation, and skips comments', () => {
    expect(pyImports('from pkg.mod import (\n    a,\n    b,\n)\n')).toContain('pkg.mod.b');
    expect(pyImports('from pkg.mod import a, \\\n    b\n')).toContain('pkg.mod.b');
    expect(pyImports('# from pkg.mod import a\n')).toEqual([]);
  });

  it('reads a dynamic import by its literal module name', () => {
    expect(pyImports("importlib.import_module('lazy.mod')\n")).toContain('lazy.mod');
  });
});

describe('discovery finds the tests that import a target', () => {
  beforeEach(() => {
    write('demo/__init__.py', '');
    write('demo/redact.py', 'def mask(t):\n    return t\n');
    write('demo/pipeline.py', 'from demo.redact import mask\n');
    write('tests/test_redact.py', 'from demo.redact import mask\n\ndef test_x():\n    assert mask("a") == "a"\n');
    write('tests/test_unrelated.py', 'def test_y():\n    assert True\n');
  });

  it('matches by module name however the path got onto sys.path', () => {
    expect(pyFileImports(dir, join(dir, 'tests/test_redact.py'), 'demo/redact.py', 'tests/test_redact.py')).toBe(true);
    expect(pyFileImports(dir, join(dir, 'tests/test_unrelated.py'), 'demo/redact.py', 'tests/test_unrelated.py')).toBe(false);
  });

  it('a package is reached by importing anything inside it', () => {
    // `import demo.redact` loads demo/__init__.py too, so a test that imports a
    // submodule defends a fault in the package's __init__.
    write('tests/test_pkg.py', 'import demo.redact\n\ndef test_x():\n    assert demo.redact is not None\n');
    expect(discoverDefenders(dir, 'demo/__init__.py')).toContain('tests/test_pkg.py');
    // and a module that merely shares a prefix is not the package
    expect(discoverDefenders(dir, 'demo/redact.py')).not.toContain('tests/test_unrelated.py');
  });

  it('discovers Python defenders for a .py target, not JavaScript ones', () => {
    expect(discoverDefenders(dir, 'demo/redact.py')).toEqual(['tests/test_redact.py']);
  });

  it('blast radius counts non-test importers only', () => {
    expect(pyBlastRadius(dir, 'demo/redact.py')).toBe(1); // demo/pipeline.py, not the test
  });

  it('recognises both Python test naming conventions and neither for source', () => {
    expect(IS_PY_TEST.test('tests/test_a.py')).toBe(true);
    expect(IS_PY_TEST.test('tests/a_test.py')).toBe(true);
    expect(IS_PY_TEST.test('demo/redact.py')).toBe(false);
  });
});

describe('patching is not mocking, and the difference decides whether a file is a defender', () => {
  beforeEach(() => {
    write('demo/__init__.py', '');
    write('demo/redact.py', 'def mask(t):\n    return t\n\ndef compile_rules(p):\n    return p\n');
  });

  it('a patch of one attribute leaves the file a defender and names the attribute', () => {
    write('tests/test_attr.py', [
      'from unittest.mock import patch',
      'from demo.redact import mask',
      '',
      'def test_mask():',
      '    with patch("demo.redact.compile_rules", return_value=[]):',
      '        assert mask("a") == "a"',
    ].join('\n'));
    const r = classifyDefenders(dir, 'demo/redact.py', ['tests/test_attr.py']);
    expect(r.canDetect).toEqual(['tests/test_attr.py']);
    expect(r.mocking).toEqual([]);
    expect(r.signals).toEqual([{ file: 'tests/test_attr.py', signal: 'target-attribute-patched', reason: 'demo.redact.compile_rules' }]);
  });

  it('a patch of the module itself removes the file, as vi.mock does', () => {
    write('tests/test_whole.py', [
      'from unittest.mock import patch',
      'import demo.redact',
      '',
      'def test_it():',
      '    with patch("demo.redact") as fake:',
      '        fake.mask.return_value = ""',
      '        assert fake.mask("a") == ""',
    ].join('\n'));
    const r = classifyDefenders(dir, 'demo/redact.py', ['tests/test_whole.py']);
    expect(r.canDetect).toEqual([]);
    expect(r.mocking).toEqual(['tests/test_whole.py']);
    expect(r.signals).toEqual([{ file: 'tests/test_whole.py', signal: 'mocked-never-asserted' }]);
  });

  it('an annotated whole-module patch is silenced with its reason, never hidden', () => {
    write('tests/test_ann.py', [
      'from unittest.mock import patch',
      'import demo.redact',
      '',
      'def test_it():',
      '    # unasserted: the module is a stand-in for an external service here',
      '    with patch("demo.redact"):',
      '        pass',
    ].join('\n'));
    const r = classifyDefenders(dir, 'demo/redact.py', ['tests/test_ann.py']);
    expect(r.signals).toEqual([{ file: 'tests/test_ann.py', signal: 'unasserted-annotated', reason: 'the module is a stand-in for an external service here' }]);
  });

  it('a whole-module patch that IS asserted on carries no signal, though it is still not a defender', () => {
    write('tests/test_asserted.py', [
      'from unittest.mock import patch',
      'from demo.redact import mask',
      '',
      'def test_it():',
      '    with patch("demo.redact"):',
      '        assert mask is not None',
    ].join('\n'));
    const r = classifyDefenders(dir, 'demo/redact.py', ['tests/test_asserted.py']);
    expect(r.mocking).toEqual(['tests/test_asserted.py']);
    expect(r.signals).toEqual([]);
  });

  it('a patch of an unrelated module is neither', () => {
    write('tests/test_other.py', 'from unittest.mock import patch\nfrom demo.redact import mask\n\ndef test_it():\n    with patch("requests.get"):\n        assert mask("a") == "a"\n');
    const r = classifyDefenders(dir, 'demo/redact.py', ['tests/test_other.py']);
    expect(r.canDetect).toEqual(['tests/test_other.py']);
    expect(r.signals).toEqual([]);
  });

  it('pyPatches separates the two by the dotted path alone', () => {
    const target = { dotted: 'demo.redact', isPackage: false };
    expect(pyPatches('patch("demo.redact")', target)).toEqual({ whole: ['demo.redact'], attributes: [] });
    expect(pyPatches('mocker.patch("demo.redact.mask")', target)).toEqual({ whole: [], attributes: ['demo.redact.mask'] });
    expect(pyPatches('monkeypatch.setattr("demo.other.mask", x)', target)).toEqual({ whole: [], attributes: [] });
  });

  it('a file that imports nothing from the target reports so', () => {
    write('tests/test_none.py', 'def test_it():\n    assert True\n');
    expect(analyzePyDefender(dir, 'tests/test_none.py', 'demo/redact.py').imports).toBe(false);
    expect(analyzePyDefender(dir, 'tests/missing.py', 'demo/redact.py')).toMatchObject({ imports: false, mocks: false });
  });

  it('discoverDefendersDetailed reports importers, mockers and the detectable set apart', () => {
    write('tests/test_a.py', 'from demo.redact import mask\n\ndef test_a():\n    assert mask("x") == "x"\n');
    write('tests/test_b.py', 'from unittest.mock import patch\nimport demo.redact\n\ndef test_b():\n    with patch("demo.redact"):\n        pass\n');
    const d = discoverDefendersDetailed(dir, 'demo/redact.py');
    expect(d.importing.sort()).toEqual(['tests/test_a.py', 'tests/test_b.py']);
    expect(d.canDetect).toEqual(['tests/test_a.py']);
    expect(d.mocking).toEqual(['tests/test_b.py']);
  });
});

describe('a virtualenv inside the project is never walked', () => {
  it('site-packages test files are not the project s tests', () => {
    write('.venv/lib/python3.12/site-packages/anything/test_installed.py', 'def test_x(): pass\n');
    write('venv/lib/test_other.py', 'def test_y(): pass\n');
    write('__pycache__/test_cached.py', '');
    write('tests/test_mine.py', 'def test_mine(): pass\n');
    expect(discoverDefendersDetailed(dir, 'demo/redact.py').importing).toEqual([]);
    expect(pyBlastRadius(dir, 'tests/test_mine.py')).toBe(0);
  });
});
