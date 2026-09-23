// @req FR-13
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { replay } from '../src/replay/replay.mjs';
import { validate } from '../spec/lib/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'known-answer-python');
const hasPython = spawnSync('python3', ['-c', 'import sys'], { encoding: 'utf8' }).status === 0;

/**
 * The Python fixture as its own repository with one scripted fix: a bug in
 * `mask` introduced, then corrected together with a test.
 *
 * The point of this corpus is narrow. `tests/test_redact.py` reaches its
 * target with `from demo.redact import ...`, which is a MODULE import and not
 * a quoted specifier. Resolving it with the JavaScript importer matched
 * nothing, so `related` was empty for every Python fix and every verdict was
 * `nocover` — "no test imports the reverted source" — whatever the suite
 * contained.
 */
function corpus() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-replay-py-'));
  cpSync(FIXTURE, dir, { recursive: true, filter: (s) => !/node_modules|\.flake-counter|\.testguard/.test(s) });
  const g = (...args) => {
    const r = spawnSync('git', ['-c', 'user.email=r@example.invalid', '-c', 'user.name=r', ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const srcPath = join(dir, 'demo', 'redact.py');
  const testPath = join(dir, 'tests', 'test_redact.py');
  const edit = (path, from, to) => {
    const body = readFileSync(path, 'utf8');
    if (!body.includes(from)) throw new Error(`corpus setup: ${from} not in ${path}`);
    writeFileSync(path, body.replace(from, to));
  };

  const MASK_OK = 'out = rule.sub(lambda m: "*" * len(m.group(0)), out)';
  const MASK_BROKEN = 'out = out  # BUG: the match is never replaced';

  // A bug ships.
  edit(srcPath, MASK_OK, MASK_BROKEN);
  g('init', '-q');
  g('add', '-A');
  g('commit', '-qm', 'feat: redaction pipeline');

  // It is fixed, with a test — which is what makes this a fix commit.
  edit(srcPath, MASK_BROKEN, MASK_OK);
  const t = readFileSync(testPath, 'utf8');
  writeFileSync(testPath, `${t}\n\nclass MaskRegression(unittest.TestCase):\n    def test_mask_replaces_the_match(self):\n        rules = compile_rules([r"\\d{3}"])\n        self.assertEqual(mask("abc 123", rules), "abc ***")\n`);
  g('add', '-A');
  g('commit', '-qm', 'fix(redact): mask actually replaces the match');
  return { dir };
}

describe.skipIf(!hasPython)('replay resolves Python importers with the Python resolver', () => {
  let c, doc;
  beforeAll(async () => {
    c = corpus();
    doc = await replay({ projectDir: c.dir, range: 'HEAD~1..HEAD', confirmRuns: 1, budgetMs: 60_000, toolVersion: 'test' });
  }, 300_000);
  afterAll(() => { if (c?.dir) rmSync(c.dir, { recursive: true, force: true }); });

  it('finds the fix commit and reaches a verdict about the SUITE, not about discovery', () => {
    expect(doc.records).toHaveLength(1);
    const r = doc.records[0];
    // The regression this guards: `nocover` with `ranTests: 0` means no test
    // file was found to import `demo/redact.py`. `tests/test_redact.py` does,
    // by module name, so any verdict here must be one that ran something.
    expect(r.reason).not.toBe('no-test-imports-the-reverted-source');
    expect(r.verdict).not.toBe('nocover');
    expect(r.ranTests).toBeGreaterThan(0);
  });

  it('the suite knew: the fix shipped a test, and the rest of the suite also covers mask', () => {
    // `test_redact.py` asserts on `mask` independently of the regression test
    // the fix added, so deleting the fix's own file still leaves a detector.
    expect(['caught', 'blind']).toContain(doc.records[0].verdict);
  });

  it('the document conforms', () => expect(validate('replay', doc).errors).toEqual([]));
});
