import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, symlinkSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main } from '../src/cli.mjs';
import { decideAdmission } from '../src/admit/admit.mjs';
import { readSpecDoc } from '../src/evidence/writer.mjs';
import { validate } from '../spec/lib/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'known-answer');
const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } };
};
const rec = (id, verdict, reason) => ({ subject: { id }, verdict, detail: reason ? { reason } : {} });

describe('decideAdmission (pure)', () => {
  it('admits only when every fault is killed', () => {
    expect(decideAdmission([rec('F1', 'killed'), rec('F2', 'killed')])).toEqual({ admitted: true, blocking: null });
    // one kill is not enough — the whole point of the two gates
    expect(decideAdmission([rec('F1', 'survived'), rec('F2', 'killed')]).admitted).toBe(false);
    expect(decideAdmission([rec('F1', 'killed'), rec('F2', 'survived')]).admitted).toBe(false);
  });
  it('names the first blocking fault in gate order: survived before flaky-defender', () => {
    const d = decideAdmission([rec('F1', 'flaky-defender', 'defenders-not-green'), rec('F2', 'killed'), rec('F3', 'survived')]);
    expect(d.admitted).toBe(false);
    expect(d.blocking.subject.id).toBe('F3');
  });
  it('never admits an empty record set', () => {
    expect(decideAdmission([])).toEqual({ admitted: false, blocking: null });
  });
});

describe('testguard admit on the known-answer fixture', () => {
  let scratch;
  const testFile = () => join(scratch, 'test', 'redact.test.mjs');
  let original;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'testguard-admit-'));
    cpSync(FIXTURE, scratch, { recursive: true, filter: (src) => !/node_modules|\.flake-counter/.test(src) });
    symlinkSync(join(ROOT, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    const g = (...args) => {
      const r = spawnSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', ...args], { cwd: scratch, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    g('init', '-q');
    g('add', '-A');
    g('commit', '-q', '-m', 'fixture');
    original = readFileSync(testFile(), 'utf8');
  });
  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('usage errors: no --claim → 3; unknown claim → 2; a test that is not a defender → 3 with the defendedBy line to add', async () => {
    const a = capture();
    expect(await main(['admit', testFile()], a.io)).toBe(3);
    expect(a.lines.err[0]).toMatch(/usage: testguard admit/);
    const b = capture();
    expect(await main(['admit', testFile(), '--claim', 'NOPE-1'], b.io)).toBe(2);
    expect(b.lines.err.join('\n')).toMatch(/unknown claim id NOPE-1/);
    const c = capture();
    expect(await main(['admit', join(scratch, 'test', 'flaky.test.mjs'), '--claim', 'REDACT-003'], c.io)).toBe(3);
    expect(c.lines.err.join('\n')).toMatch(/not a defender of REDACT-003.*"defendedBy": \["test\/redact\.test\.mjs", "test\/flaky\.test\.mjs"\]/s);
  });

  it('the weak fixture test is NOT ADMITTED for REDACT-001: F1 survives although F2 is killed → exit 1, --json names both', async () => {
    const a = capture();
    const code = await main(['admit', testFile(), '--claim', 'REDACT-001', '--budget', '30000', '--json'], a.io);
    expect(code).toBe(1);
    const out = JSON.parse(a.lines.out.join('\n'));
    expect(out).toMatchObject({ admitted: false, provisional: false, claim: 'REDACT-001', test: 'test/redact.test.mjs' });
    // the fixture oracle decides which faults survive; the point here is that one killed fault (F2) does not admit
    const oracle = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8')).expected;
    expect(out.faults.map((f) => [f.id, f.verdict])).toEqual(out.faults.map((f) => [f.id, oracle[`REDACT-001/${f.id}`].verdict]));
    expect(out.faults.map((f) => f.verdict)).toContain('killed');
    expect(out.faults.map((f) => f.verdict)).toContain('survived');
    expect(out.faults[0].hint).toMatch(/stayed green with this fault applied/);
    expect(out.command).toBe('testguard probe --claim REDACT-001 --include-dirty --confirm 3 --no-escalate');
    const ev = readSpecDoc('evidence', out.evidence);
    expect(validate('evidence', ev).errors).toEqual([]);
    expect(ev.records).toHaveLength(out.faults.length);
    expect(existsSync(join(scratch, '.testguard', 'evidence.json'))).toBe(false); // never the canonical file
    const b = capture();
    expect(await main(['admit', testFile(), '--claim', 'REDACT-001', '--budget', '30000'], b.io)).toBe(1);
    expect(b.lines.out.join('\n')).toMatch(/^NOT ADMITTED: survived on REDACT-001\/F1$/m);
  }, 120_000);

  it('an uncommitted test that kills REDACT-003/F1 is ADMITTED (exit 0); --confirm 1 gives ADMITTED? and marks it provisional', async () => {
    writeFileSync(testFile(), original + `
it('fails closed on a missing scope (uncommitted)', async () => {
  await expect(redact('x', RULES, {}, { writeAudit: vi.fn() })).rejects.toThrow(/scope/);
});
`);
    try {
      const a = capture();
      expect(await main(['admit', testFile(), '--claim', 'REDACT-003', '--budget', '30000'], a.io)).toBe(0);
      expect(a.lines.out.join('\n')).toMatch(/^ADMITTED — test\/redact\.test\.mjs passes on HEAD and fails on the fault of REDACT-003, 3\/3\. Commit it\.$/m);
      // the tree, HEAD and index are untouched: the test is still uncommitted
      expect(spawnSync('git', ['status', '--porcelain'], { cwd: scratch, encoding: 'utf8' }).stdout).toMatch(/^ M test\/redact\.test\.mjs/m);

      const b = capture();
      expect(await main(['admit', testFile(), '--claim', 'REDACT-003', '--fault', 'F1', '--confirm', '1', '--budget', '30000', '--json'], b.io)).toBe(0);
      const out = JSON.parse(b.lines.out.join('\n'));
      expect(out).toMatchObject({ admitted: true, provisional: true });
      expect(out.faults).toEqual([{ id: 'F1', verdict: 'killed', hint: '' }]);
      const c = capture();
      expect(await main(['admit', testFile(), '--claim', 'REDACT-003', '--confirm', '1', '--budget', '30000'], c.io)).toBe(0);
      expect(c.lines.out.join('\n')).toMatch(/^ADMITTED\? — .*Provisional: confirm with --confirm 3/m);
      expect(c.lines.err.join('\n')).toMatch(/^PROVISIONAL — confirmRuns 1/m);
    } finally {
      writeFileSync(testFile(), original);
    }
  }, 180_000);

  it('--fault with an unknown fault id is a precondition failure', async () => {
    const a = capture();
    expect(await main(['admit', testFile(), '--claim', 'REDACT-003', '--fault', 'F9'], a.io)).toBe(2);
    expect(a.lines.err.join('\n')).toMatch(/has no fault F9/);
  });
});
