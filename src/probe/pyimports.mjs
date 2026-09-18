import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { walk } from '../util/glob.mjs';

/**
 * Python import and patch analysis: the counterpart of the specifier
 * resolution in `rank.mjs`, which understands only JavaScript.
 *
 * Without it every Python claim that declares no `defendedBy` resolves to no
 * defender and reports `nocover` — not an error, not a warning, just a quiet
 * and wrong answer about a suite that may defend the claim perfectly well.
 *
 * Python is matched on module names rather than on paths, because that is what
 * Python itself matches on: a file at `src/pkg/mod.py` is imported as
 * `pkg.mod` from anywhere on `sys.path`, and the test that reaches it by
 * inserting `src/` into `sys.path` is indistinguishable, at the import site,
 * from one that reaches it through an installed distribution.
 */

const PY = /\.py$/;
const COMMENT = /^\s*#/;

/**
 * The dotted module name of a file, and the directory that name is relative
 * to: walk up while each directory is a package (`__init__.py`), exactly as
 * Python resolves a module to its package. `src/pkg/mod.py` with
 * `src/pkg/__init__.py` present and no `src/__init__.py` is `pkg.mod` rooted
 * at `src`.
 *
 * A package's own `__init__.py` is the package: `pkg/__init__.py` is `pkg`,
 * not `pkg.__init__`, which is what makes `import pkg.anything` reach it.
 */
export function pyModuleName(projectDir, rel) {
  const parts = [basename(rel).replace(PY, '')];
  if (parts[0] === '__init__') parts.pop();
  let dir = dirname(join(projectDir, rel));
  for (let depth = 0; depth < 32; depth++) {
    if (!existsSync(join(dir, '__init__.py'))) break;
    parts.unshift(basename(dir));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { dotted: parts.join('.'), isPackage: basename(rel) === '__init__.py' };
}

/**
 * Logical import lines: `\` continuations joined, and a parenthesised
 * `from x import (a, b)` collapsed onto one line so the names are visible.
 */
function logicalLines(source) {
  const raw = source.split('\n');
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i];
    if (COMMENT.test(line)) continue;
    while (/\\\s*$/.test(line) && i + 1 < raw.length) line = line.replace(/\\\s*$/, ' ') + raw[++i];
    if (/^\s*from\s/.test(line) && line.includes('(') && !line.includes(')')) {
      // Bounded: a malformed file must not make this loop to the end of a large source.
      for (let n = 0; n < 200 && i + 1 < raw.length && !line.includes(')'); n++) line += ' ' + raw[++i];
    }
    out.push(line);
  }
  return out;
}

/** The package a file lives in, as a dotted name ('' when it is not in a package). */
function packageOf(projectDir, rel) {
  const dir = dirname(rel);
  if (dir === '.' || dir === '') return '';
  return pyModuleName(projectDir, join(dir, '__init__.py')).dotted;
}

/**
 * Every module path a source imports, as absolute dotted names.
 *
 * `from pkg import mod` is recorded as both `pkg` and `pkg.mod`, because
 * Python cannot tell the two apart at the import site and neither can a
 * reader: whether `mod` is a submodule or an attribute of `pkg` depends on
 * what is on disk. Recording both is the pessimistic reading — it can only
 * make a file count as a defender that might not be, never hide one that is.
 */
export function pyImports(source, selfPackage = '') {
  const found = new Set();
  const absolute = (level, module) => {
    if (level === 0) return module;
    const parts = selfPackage ? selfPackage.split('.') : [];
    const base = parts.slice(0, Math.max(0, parts.length - (level - 1)));
    return [...base, ...(module ? module.split('.') : [])].join('.');
  };

  for (const line of logicalLines(source)) {
    const plain = /^\s*import\s+(.+?)\s*$/.exec(line);
    if (plain && !/^\s*import\s*\(/.test(line)) {
      for (const piece of plain[1].split(',')) {
        const name = piece.trim().split(/\s+as\s+/)[0].trim();
        if (/^[\w.]+$/.test(name)) found.add(name);
      }
      continue;
    }
    const rel = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+?)\s*$/.exec(line);
    if (rel) {
      const base = absolute(rel[1].length, rel[2]);
      if (base) found.add(base);
      const names = rel[3].replace(/[()]/g, '');
      if (!names.includes('*')) {
        for (const piece of names.split(',')) {
          const name = piece.trim().split(/\s+as\s+/)[0].trim();
          if (/^\w+$/.test(name)) found.add(base ? `${base}.${name}` : name);
        }
      }
    }
  }
  // `importlib.import_module('pkg.mod')` and `__import__('pkg.mod')`.
  for (const m of source.matchAll(/(?:import_module|__import__)\s*\(\s*(['"])([\w.]+)\1/g)) found.add(m[2]);
  return [...found];
}

/** Does `dotted` name the target module, or something inside it when the target is a package's `__init__.py`? */
function hits(dotted, target) {
  if (!target.dotted) return false;
  return dotted === target.dotted || (target.isPackage && dotted.startsWith(target.dotted + '.'));
}

/** Does the Python file at `absFile` import `targetRel`? */
export function pyFileImports(projectDir, absFile, targetRel, testRel) {
  const target = pyModuleName(projectDir, targetRel);
  if (!target.dotted) return false;
  let source;
  try {
    source = readFileSync(absFile, 'utf8');
  } catch {
    return false;
  }
  return pyImports(source, packageOf(projectDir, testRel ?? absFile)).some((d) => hits(d, target));
}

/** Non-test Python files that import the target, by direct import only. */
export function pyBlastRadius(projectDir, targetRel) {
  const target = pyModuleName(projectDir, targetRel);
  if (!target.dotted) return 0;
  let count = 0;
  for (const rel of walk(projectDir)) {
    if (!PY.test(rel) || rel === targetRel || IS_PY_TEST.test(rel)) continue;
    let source;
    try {
      source = readFileSync(join(projectDir, rel), 'utf8');
    } catch {
      continue;
    }
    if (pyImports(source, packageOf(projectDir, rel)).some((d) => hits(d, target))) count++;
  }
  return count;
}

export const IS_PY_TEST = /(^|\/)(test[^/]*\.py|[^/]*_test\.py)$/;

const PATCH_STRING = /\b(?:mock\.|unittest\.mock\.|mocker\.|monkeypatch\.)?(?:patch|setattr|setitem|patch\.object|patch\.dict)\s*\(\s*(['"])([\w.]+)\1/g;
// `.test()` on a global regex advances its lastIndex and carries that state to
// the next call. The predicate gets its own non-global copy so line-by-line
// scanning cannot silently start matching from the middle of a line.
const PATCH_LINE = new RegExp(PATCH_STRING.source);
const UNASSERTED = /unasserted:\s*(.+?)\s*$/;
const ASSERT_LINE = /(^|[^\w.])assert(?:\s|_|\b)|\bself\.assert\w*\s*\(|\bassert\w*\s*\(/;

/**
 * Which parts of the target a test replaces.
 *
 * This is where Python and JavaScript genuinely differ, and copying the
 * JavaScript rule would be wrong. `vi.mock('./mod')` replaces a whole module,
 * so a file that calls it can detect nothing in that module and is never a
 * defender. `patch('pkg.mod.fn')` replaces **one attribute**: a fault anywhere
 * else in `pkg.mod` is still fully detectable, and excluding the file would
 * turn a real verdict into `nocover` — the same silent wrong answer, pointing
 * the other way.
 *
 * So only a patch of the module itself disqualifies a defender. An attribute
 * patch leaves the file a defender and is reported as a signal, because it is
 * still the cheapest available hint about where that test is blind.
 */
export function pyPatches(source, target) {
  const whole = [];
  const attributes = [];
  for (const m of source.matchAll(PATCH_STRING)) {
    const path = m[2];
    if (!target.dotted) continue;
    if (path === target.dotted) whole.push(path);
    else if (path.startsWith(target.dotted + '.')) attributes.push(path);
  }
  return { whole, attributes };
}

/** Does any assertion in the file mention a name bound from the target? */
function assertsOnTarget(source, bindings) {
  if (bindings.length === 0) return false;
  for (const line of source.split('\n')) {
    if (COMMENT.test(line) || !ASSERT_LINE.test(line)) continue;
    for (const b of bindings) if (new RegExp(`(^|[^\\w.])${b}(?![\\w])`).test(line)) return true;
  }
  return false;
}

/** Local names this source binds from the target module. */
function bindingsFor(source, target, selfPackage) {
  const names = new Set();
  for (const line of logicalLines(source)) {
    const rel = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+?)\s*$/.exec(line);
    if (rel) {
      const parts = selfPackage ? selfPackage.split('.') : [];
      const base = rel[1].length === 0 ? rel[2] : [...parts.slice(0, Math.max(0, parts.length - (rel[1].length - 1))), ...(rel[2] ? rel[2].split('.') : [])].join('.');
      const list = rel[3].replace(/[()]/g, '');
      for (const piece of list.split(',')) {
        const [imported, alias] = piece.trim().split(/\s+as\s+/).map((x) => x && x.trim());
        if (!imported || !/^\w+$/.test(imported)) continue;
        if (base === target.dotted) names.add(alias || imported);              // from pkg.mod import fn
        else if (`${base}.${imported}` === target.dotted) names.add(alias || imported); // from pkg import mod
      }
      continue;
    }
    const plain = /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(line);
    if (plain && plain[1] === target.dotted) names.add(plain[2] || plain[1].split('.')[0]);
  }
  return [...names];
}

/**
 * How one Python test file relates to one target: does it import it, does it
 * replace the whole module, which attributes of it does it replace, does it
 * ever assert on anything it took from it, and did the author annotate an
 * unasserted patch with a reason (`# unasserted: <why>` on or above the line).
 */
export function analyzePyDefender(projectDir, testRel, targetRel) {
  const target = pyModuleName(projectDir, targetRel);
  let source;
  try {
    source = readFileSync(join(projectDir, testRel), 'utf8');
  } catch {
    return { file: testRel, imports: false, mocks: false, asserted: false, annotation: null, patchedAttributes: [] };
  }
  const selfPackage = packageOf(projectDir, testRel);
  const imports = pyImports(source, selfPackage).some((d) => hits(d, target));
  const { whole, attributes } = pyPatches(source, target);
  const bindings = bindingsFor(source, target, selfPackage);
  const asserted = assertsOnTarget(source, bindings);

  let annotation = null;
  if (whole.length || attributes.length) {
    const lines = source.split('\n');
    lines.forEach((text, i) => {
      if (annotation || !PATCH_LINE.test(text)) return;
      for (let j = i; j >= Math.max(0, i - 2) && !annotation; j--) {
        const a = UNASSERTED.exec(lines[j]);
        if (a) annotation = a[1];
      }
    });
  }
  return { file: testRel, imports, mocks: whole.length > 0, asserted, annotation, patchedAttributes: attributes };
}

/**
 * The Python reading of the same question, which is deliberately not the
 * JavaScript one.
 *
 * `vi.mock('./mod')` replaces a module; `patch('pkg.mod.fn')` replaces a single
 * attribute of one. Applying the JavaScript rule to Python would drop every
 * test that patches anything in the target — including tests that defend it
 * perfectly — and report `nocover` for a claim that is in fact well covered.
 * So only a patch of the module itself removes a defender. An attribute patch
 * keeps it and raises `target-attribute-patched`, which names the attributes:
 * a fault in one of them is the place that test is least likely to notice.
 */
export function classifyPythonDefenders(projectDir, targetRel, candidates) {
  const canDetect = [];
  const mocking = [];
  const signals = [];
  for (const file of candidates) {
    const a = analyzePyDefender(projectDir, file, targetRel);
    if (a.mocks) {
      mocking.push(file);
      if (!a.asserted) signals.push(a.annotation ? { file, signal: 'unasserted-annotated', reason: a.annotation } : { file, signal: 'mocked-never-asserted' });
    } else {
      canDetect.push(file);
      if (a.patchedAttributes.length) signals.push({ file, signal: 'target-attribute-patched', reason: a.patchedAttributes.slice(0, 8).join(', ') });
    }
  }
  return { canDetect, mocking, signals };
}
