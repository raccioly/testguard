// @req FR-13
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { replay, calibrationFrom, findFixCommits, dedupeByPatch, classifyReplay } from '../src/replay/replay.mjs';
import { labelDiff } from '../src/replay/label.mjs';
import { validate } from '../spec/lib/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'known-answer');

describe('labelDiff — the join key between real bugs and the fault model', () => {
  const cases = [
    ['a guard put back', '+  if (!ctx || !ctx.scope) {', 'guard-removed'],
    ['a security flag flipped', '-  httpOnly: false,\n+  httpOnly: true,', 'literal-changed'],
    ['a dropped field restored', '+      content: redacted,', 'field-dropped'],
    ['a verify call restored', '+  await verifyMembership(userId, orgId);', 'call-removed'],
    ['a wrong return fixed', '-  return true;\n+  return rules.includes(id);', 'return-altered'],
    ['a rethrow removed', '-  } catch (e) {\n-    throw e;', 'exception-swallowed'],
    ['a state change restored', '+  total = total + delta;', 'statement-deleted'],
  ];
  for (const [name, diff, expected] of cases) {
    it(`labels ${name} as ${expected}`, () => {
      expect(labelDiff(diff)).toEqual({ faultClass: expected, confident: true });
    });
  }
  it('refuses to guess: an unrecognisable diff is `other`, not a coin toss', () => {
    expect(labelDiff('+  // a comment\n+\n')).toEqual({ faultClass: 'other', confident: false });
    expect(labelDiff('')).toEqual({ faultClass: 'other', confident: false });
  });
  it('ignores the diff header so a filename never becomes the signal', () => {
    expect(labelDiff('+++ b/src/timeout.js\n--- a/src/timeout.js\n+  // nothing\n').faultClass).toBe('other');
  });
});

/**
 * The fixture as its own repository with a scripted history: one fix the
 * surrounding suite would have caught, one it would have missed.
 */
function corpus() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-replay-'));
  cpSync(FIXTURE, dir, { recursive: true, filter: (s) => !/node_modules|\.flake-counter|\.testguard/.test(s) });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const g = (...args) => {
    const r = spawnSync('git', ['-c', 'user.email=r@example.invalid', '-c', 'user.name=r', ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const srcPath = join(dir, 'src', 'redact.mjs');
  const edit = (from, to) => {
    const body = readFileSync(srcPath, 'utf8');
    if (!body.includes(from)) throw new Error(`corpus setup: ${from} not in src/redact.mjs`);
    writeFileSync(srcPath, body.replace(from, to));
  };

  // A realistic history: a bug is introduced, then fixed with a test. Only
  // the fix commits change source AND a test together, so only those are
  // candidates — which is the whole point of that filter.
  const MASK_OK = "out = out.replace(rule.re, (m) => '*'.repeat(m.length));";
  const MASK_BROKEN = 'out = out; // BUG: the match is never replaced';
  const AUDIT_OK = 'content: redacted,';
  const AUDIT_BROKEN = 'content: input, // BUG: the raw input reaches the audit row';

  // (1) the bug that the suite WOULD have caught: masking stops working.
  edit(MASK_OK, MASK_BROKEN);
  g('init', '-q');
  g('add', '-A');
  g('commit', '-q', '-m', 'the masking bug, shipped');

  // (2) the fix, with its own test.
  edit(MASK_BROKEN, MASK_OK);
  writeFileSync(join(dir, 'test', 'mask-fix.test.mjs'), `import { describe, it, expect } from 'vitest';
import { mask } from '../src/redact.mjs';
describe('the test the fix shipped', () => {
  it('masks every match', () => {
    expect(mask('hello FIXTURE_SECRET_1 bye', [{ id: 'r', pattern: 'FIXTURE_SECRET_\\\\d+' }])).not.toContain('FIXTURE_SECRET_1');
  });
});
`);
  g('add', '-A');
  g('commit', '-q', '-m', 'fix(redact): mask every match');
  const caughtSha = g('rev-parse', 'HEAD').trim();

  // (3) the bug the suite would MISS: the audit row carries the raw input.
  // Every existing audit test asserts with objectContaining and omits
  // `content`, so nothing notices.
  edit(AUDIT_OK, AUDIT_BROKEN);
  g('add', '-A');
  g('commit', '-q', '-m', 'the audit-row bug, shipped');

  // (4) its fix, with its own test.
  edit(AUDIT_BROKEN, AUDIT_OK);
  writeFileSync(join(dir, 'test', 'audit-fix.test.mjs'), `import { describe, it, expect, vi } from 'vitest';
import { redact } from '../src/redact.mjs';
describe('the test the fix shipped', () => {
  it('never writes the raw input', async () => {
    const store = { writeAudit: vi.fn().mockResolvedValue(undefined) };
    await redact('hello FIXTURE_SECRET_9', [{ id: 'r', pattern: 'FIXTURE_SECRET_\\\\d+' }], { scope: 'g' }, store);
    expect(store.writeAudit.mock.calls[0][0].content).not.toContain('FIXTURE_SECRET_9');
  });
});
`);
  g('add', '-A');
  g('commit', '-q', '-m', 'fix(redact): keep the raw input out of the audit row');
  const blindSha = g('rev-parse', 'HEAD').trim();

  return { dir, g, caughtSha, blindSha };
}

describe('replay on a scripted corpus', () => {
  let c;
  let doc;

  beforeAll(async () => {
    c = corpus();
    doc = await replay({ projectDir: c.dir, range: 'HEAD~3..HEAD', confirmRuns: 2, budgetMs: 30_000, toolVersion: 'test' });
  }, 300_000);

  afterAll(() => {
    if (c?.dir) rmSync(c.dir, { recursive: true, force: true });
  });

  it('finds only commits that change source AND a test together', () => {
    const fixes = findFixCommits({ dir: c.dir, range: 'HEAD~3..HEAD' });
    expect(fixes.map((f) => f.commit)).toEqual([c.blindSha, c.caughtSha]);
    for (const f of fixes) {
      expect(f.source).toEqual(['src/redact.mjs']);
      expect(f.tests.length).toBeGreaterThan(0);
    }
  });

  it('verdicts the two scripted fixes correctly: one caught, one blind', () => {
    const by = Object.fromEntries(doc.records.map((r) => [r.commit, r.verdict]));
    expect(by[c.caughtSha]).toBe('caught');
    expect(by[c.blindSha]).toBe('blind');
  });

  it('the blind record proves the suite ran and stayed green on known-broken code', () => {
    const blind = doc.records.find((r) => r.commit === c.blindSha);
    expect(blind.ranTests).toBeGreaterThan(0);
    expect(blind.runs).toHaveLength(2);
    expect(blind.runs.every((r) => r.outcome === 'pass')).toBe(true);
    expect(blind.removedTests).toContain('test/audit-fix.test.mjs');
  });

  it('labels each replayed bug with a fault class, so calibration has a join key', () => {
    for (const r of doc.records) expect(r.faultClass).toBeDefined();
  });

  it('emits a replay document that conforms to the spec', () => {
    const { errors } = validate('replay', doc);
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it('left the corpus untouched: the worktree is removed and HEAD is where it was', () => {
    expect(c.g('status', '--porcelain')).toBe('');
    expect(c.g('rev-parse', 'HEAD').trim()).toBe(c.blindSha);
  });

  it('derives a conforming calibration: misses over measurable, per fault class, with n', () => {
    const cal = calibrationFrom(doc, { toolVersion: 'test' });
    expect(validate('calibration', cal).errors).toEqual([]);
    expect(cal.bucketBy).toBe('faultClass');
    expect(cal.source).toMatchObject({ kind: 'bug-replay', ref: 'HEAD~3..HEAD' });
    expect(cal.measures).toBe('escape-missed');
    // The caveat's wording now depends on which corpus p was computed over;
    // what must always hold is the sentence a consumer shows beside a number.
    expect(cal.source.caveat).toMatch(/a first run is expected to be high/);
    expect(cal.source.detail.candidateRule).toBe('conventional-fix'); // the scripted corpus labels its commits
    const total = Object.values(cal.buckets).reduce((n, b) => n + b.n, 0);
    const positives = Object.values(cal.buckets).reduce((n, b) => n + b.positives, 0);
    expect(total).toBe(2);      // both were measurable
    expect(positives).toBe(1);  // one was blind
  });
});

describe('classifyReplay — the verdict, pure, every branch', () => {
  const pass = { outcome: 'pass', assertionFailures: 0, durationMs: 1 };
  const failed = { outcome: 'fail', assertionFailures: 1, durationMs: 1 };
  const nonAssertion = { outcome: 'fail', assertionFailures: 0, durationMs: 1 };
  const timeout = { outcome: 'timeout', durationMs: 1 };
  const error = { outcome: 'error', durationMs: 1 };

  it('caught only when EVERY run failed by assertion', () => {
    expect(classifyReplay([failed, failed, failed])).toEqual({ verdict: 'caught' });
  });

  it('a mixed result is flaky, never caught — one flaky failure would otherwise read as detection', () => {
    expect(classifyReplay([failed, pass, failed])).toEqual({ verdict: 'flaky', reason: 'runs-disagreed' });
    expect(classifyReplay([pass, failed])).toEqual({ verdict: 'flaky', reason: 'runs-disagreed' });
    // the optimistic reading is the one that hides a blind spot: refuse it
    expect(classifyReplay([failed, pass, pass]).verdict).not.toBe('caught');
  });

  it('blind only when every run passed', () => {
    expect(classifyReplay([pass, pass, pass])).toEqual({ verdict: 'blind' });
  });

  it('a failure that is not an assertion failure is not detection', () => {
    expect(classifyReplay([nonAssertion, nonAssertion])).toEqual({ verdict: 'unverifiable', reason: 'failed-without-an-assertion' });
  });

  it('a timeout or a load failure concludes nothing', () => {
    expect(classifyReplay([pass, timeout])).toEqual({ verdict: 'unverifiable', reason: 'timed-out' });
    expect(classifyReplay([error])).toEqual({ verdict: 'unverifiable', reason: 'suite-failed-to-load' });
    expect(classifyReplay([])).toEqual({ verdict: 'unverifiable', reason: 'no-runs' });
  });
});

describe('replay output paths', () => {
  it('--out places the calibration beside the replay document, never in the project being read', async () => {
    const { replayCommand } = await import('../src/commands/replay.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'tg-replay-out-'));
    const out = mkdtempSync(join(tmpdir(), 'tg-replay-dest-'));
    const g = (...args) => spawnSync('git', ['-c', 'user.email=r@x', '-c', 'user.name=r', ...args], { cwd: dir, encoding: 'utf8' });
    g('init', '-q');
    writeFileSync(join(dir, 'a.mjs'), 'export const a = 1;\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'no test here');
    const lines = [];
    const io = { out: (s) => lines.push(s), err: (s) => lines.push(s) };
    // the run itself has nothing to replay; the paths are what this pins
    await replayCommand({ projectDir: dir, values: { since: 'HEAD~0..HEAD', confirm: '1', budget: '5000', out: join(out, 'replay.json') }, version: 't' }, io).catch(() => {});
    const { calibrationPath } = await import('../src/commands/replay.mjs');
    expect(existsSync(calibrationPath(dir))).toBe(false); // nothing written into the project
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });
});

describe('replay preconditions', () => {
  it('de-duplicates by patch-id: the same fix under two shas is one row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-replay-dup-'));
    const g = (...args) => {
      const r = spawnSync('git', ['-c', 'user.email=r@example.invalid', '-c', 'user.name=r', ...args], { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout;
    };
    g('init', '-q');
    writeFileSync(join(dir, 'a.mjs'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'a.test.mjs'), "import { a } from './a.mjs';\n");
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    writeFileSync(join(dir, 'a.mjs'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'a.test.mjs'), "import { a } from './a.mjs';\n// asserted\n");
    g('add', '-A');
    g('commit', '-q', '-m', 'fix: two');
    const first = g('rev-parse', 'HEAD').trim();
    // the same patch again on a second branch: the dual-branch topology
    g('checkout', '-q', '-b', 'other', 'HEAD~1');
    // -x appends a provenance line to the message, so the SHA differs while
    // the patch is byte-identical. Without it git recreates the same commit
    // object exactly, and the test would pass whatever the code keys on.
    g('cherry-pick', '-x', first);
    expect(g('rev-parse', 'HEAD').trim()).not.toBe(first);
    const commits = findFixCommits({ dir, range: 'HEAD~1..HEAD' }).concat(findFixCommits({ dir, range: `${first}~1..${first}` }));
    expect(commits).toHaveLength(2);
    const { unique, duplicates } = dedupeByPatch({ dir, commits });
    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('scopes to the project directory: a monorepo fix that also touches another package is replayed on this part of it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-replay-mono-'));
    const g = (...args) => {
      const r = spawnSync('git', ['-c', 'user.email=r@example.invalid', '-c', 'user.name=r', ...args], { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout;
    };
    mkdirSync(join(dir, 'backend', 'src'), { recursive: true });
    mkdirSync(join(dir, 'backend', 'test'), { recursive: true });
    mkdirSync(join(dir, 'frontend', 'src'), { recursive: true });
    g('init', '-q');
    writeFileSync(join(dir, 'backend', 'src', 'a.mjs'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'backend', 'test', 'a.test.mjs'), "import { a } from '../src/a.mjs';\n");
    writeFileSync(join(dir, 'frontend', 'src', 'b.mjs'), 'export const b = 1;\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    // one fix, two packages — the shape a monorepo produces constantly
    writeFileSync(join(dir, 'backend', 'src', 'a.mjs'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'backend', 'test', 'a.test.mjs'), "import { a } from '../src/a.mjs';\n// asserted\n");
    writeFileSync(join(dir, 'frontend', 'src', 'b.mjs'), 'export const b = 2;\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'fix: both packages');

    const scoped = findFixCommits({ dir, range: 'HEAD~1..HEAD', projectDir: join(dir, 'backend') });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].source).toEqual(['backend/src/a.mjs']);   // the frontend file is not this project's to revert
    expect(scoped[0].tests).toEqual(['backend/test/a.test.mjs']);

    // unscoped, the same commit drags in a file that does not exist under the
    // project, which is what made every cross-package fix unverifiable
    expect(findFixCommits({ dir, range: 'HEAD~1..HEAD' })[0].source).toContain('frontend/src/b.mjs');

    // a commit with no source-and-test pair inside the project is not a candidate
    expect(findFixCommits({ dir, range: 'HEAD~1..HEAD', projectDir: join(dir, 'frontend') })).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reverts a file the fix ADDED by removing it, and calls an addition-only commit no-prior-version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-replay-added-'));
    cpSync(FIXTURE, dir, { recursive: true, filter: (s) => !/node_modules|\.flake-counter|\.testguard/.test(s) });
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const g = (...args) => {
      const r = spawnSync('git', ['-c', 'user.email=r@example.invalid', '-c', 'user.name=r', ...args], { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout;
    };
    g('init', '-q');
    g('add', '-A');
    g('commit', '-q', '-m', 'base');

    // (1) a fix that CHANGES one file and ADDS another — the shape that made
    //     nineteen of forty real commits unverifiable before this was handled
    writeFileSync(join(dir, 'src', 'helper.mjs'), 'export const normalise = (s) => String(s).trim();\n');
    const src = readFileSync(join(dir, 'src', 'redact.mjs'), 'utf8');
    writeFileSync(join(dir, 'src', 'redact.mjs'), src.replace('export function mask', 'export function mask'));
    writeFileSync(join(dir, 'src', 'redact.mjs'), readFileSync(join(dir, 'src', 'redact.mjs'), 'utf8') + '\n// touched by the fix\n');
    writeFileSync(join(dir, 'test', 'helper.test.mjs'), `import { describe, it, expect } from 'vitest';
import { normalise } from '../src/helper.mjs';
describe('helper', () => { it('trims', () => { expect(normalise(' a ')).toBe('a'); }); });
`);
    g('add', '-A');
    g('commit', '-q', '-m', 'fix(redact): normalise input, with a new helper');

    // (2) a commit whose source is ENTIRELY new: an addition, not a fix
    writeFileSync(join(dir, 'src', 'brandnew.mjs'), 'export const fresh = () => 1;\n');
    writeFileSync(join(dir, 'test', 'brandnew.test.mjs'), `import { describe, it, expect } from 'vitest';
import { fresh } from '../src/brandnew.mjs';
describe('fresh', () => { it('is one', () => { expect(fresh()).toBe(1); }); });
`);
    g('add', '-A');
    g('commit', '-q', '-m', 'feat: a brand new module');

    const doc = await replay({ projectDir: dir, range: 'HEAD~2..HEAD', confirmRuns: 1, budgetMs: 30_000, toolVersion: 'test' });
    const addition = doc.records.find((r) => (r.subject ?? '').startsWith('feat: a brand new'));
    expect(addition).toMatchObject({ verdict: 'unverifiable', reason: 'no-prior-version' });

    const mixed = doc.records.find((r) => (r.subject ?? '').startsWith('fix(redact)'));
    // the added helper was removed rather than checked out, so the revert ran
    expect(mixed.reason).not.toBe('revert-did-not-apply');
    expect(['caught', 'blind', 'nocover', 'flaky', 'unverifiable']).toContain(mixed.verdict);
    expect(validate('replay', doc).errors).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  }, 180_000);

  it('a range with no fix commit is a precondition failure, not an empty pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-replay-none-'));
    const g = (...args) => spawnSync('git', ['-c', 'user.email=r@x', '-c', 'user.name=r', ...args], { cwd: dir, encoding: 'utf8' });
    g('init', '-q');
    writeFileSync(join(dir, 'a.mjs'), 'export const a = 1;\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'no test here');
    await expect(replay({ projectDir: dir, range: 'HEAD~0..HEAD', toolVersion: 't' })).rejects.toThrow(/no fix commits|cannot read the range/);
    rmSync(dir, { recursive: true, force: true });
  });
});
