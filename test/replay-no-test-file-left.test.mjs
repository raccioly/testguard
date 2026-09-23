// @req FR-13
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { replay } from '../src/replay/replay.mjs';
import { validate } from '../spec/lib/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A project whose ENTIRE suite is one file, which the fix also touched.
 *
 * Removing the fix's own test removes the whole FILE, and with it the tests
 * that pre-dated the fix — here, an assertion about `add` that existed before
 * the bug was introduced and would have been available to catch it. Nothing is
 * left to run, so nothing can be concluded.
 */
function corpus() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-replay-onefile-'));
  const w = (rel, body) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };
  const g = (...args) => {
    const r = spawnSync('git', ['-c', 'user.email=r@example.invalid', '-c', 'user.name=r', ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  w('package.json', JSON.stringify({ name: 'onefile', private: true, devDependencies: { vitest: '*' } }, null, 2));
  try { symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir'); } catch {}
  w('src/calc.mjs', 'export const add = (a, b) => a + b;\nexport const clamp = (n, hi) => n;\n');
  w('test/calc.test.mjs', "import { expect, it } from 'vitest';\nimport { add } from '../src/calc.mjs';\nit('adds', () => expect(add(1, 2)).toBe(3));\n");
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'feat: calc');

  // The fix corrects `clamp` and extends the ONLY test file.
  w('src/calc.mjs', 'export const add = (a, b) => a + b;\nexport const clamp = (n, hi) => (n > hi ? hi : n);\n');
  w('test/calc.test.mjs', "import { expect, it } from 'vitest';\nimport { add, clamp } from '../src/calc.mjs';\nit('adds', () => expect(add(1, 2)).toBe(3));\nit('clamps', () => expect(clamp(9, 5)).toBe(5));\n");
  g('add', '-A'); g('commit', '-qm', 'fix(calc): clamp actually clamps');
  return { dir };
}

describe('replay: no test file left is a failed measurement, not a finding', () => {
  let c, doc;
  beforeAll(async () => {
    c = corpus();
    doc = await replay({ projectDir: c.dir, range: 'HEAD~1..HEAD', confirmRuns: 1, budgetMs: 60_000, toolVersion: 'test' });
  }, 300_000);
  afterAll(() => { if (c?.dir) rmSync(c.dir, { recursive: true, force: true }); });

  it('does not charge the project for evidence the method destroyed', () => {
    expect(doc.records).toHaveLength(1);
    const r = doc.records[0];
    // `nocover` here would enter the calibration as a MISS and read as "no
    // test exercises this code" — a statement about the project. The truth is
    // that removing the fix's test removed the only test file, including the
    // `adds` assertion that pre-dated the bug.
    expect(r.verdict).toBe('unverifiable');
    expect(r.reason).toBe('the-fix-shipped-the-only-test-file');
    expect(r.ranTests).toBe(0);
  });

  it('the document conforms, and the validator refuses the mislabelled form', () => {
    expect(validate('replay', doc).errors).toEqual([]);
    const mislabelled = JSON.parse(JSON.stringify(doc));
    mislabelled.records[0].verdict = 'nocover';
    const errs = validate('replay', mislabelled).errors;
    expect(errs.some((e) => /unverifiable, not a finding about the project/.test(e.message))).toBe(true);
  });
});
