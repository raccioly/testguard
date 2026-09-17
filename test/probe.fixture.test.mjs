import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { writeSpecDoc, readSpecDoc } from '../src/evidence/writer.mjs';
import { main } from '../src/cli.mjs';

const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } };
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'known-answer');

/**
 * The acceptance test. A copy of the fixture becomes its own git repository
 * so the run never depends on this repo's git state, then `probe` runs in
 * worktree mode and must reproduce expected.json exactly.
 */
describe('probe reproduces the known-answer fixture', () => {
  let scratch;
  let evidence;
  const expected = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8'));

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'testguard-fixture-'));
    cpSync(FIXTURE, scratch, { recursive: true, filter: (src) => !/node_modules|\.flake-counter/.test(src) });
    symlinkSync(join(ROOT, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    const g = (...args) => {
      const r = spawnSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', ...args], { cwd: scratch, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    g('init', '-q');
    g('add', '-A');
    g('commit', '-q', '-m', 'fixture');

    evidence = await probe({
      projectDir: scratch,
      claims: loadClaims(join(scratch, 'testguard.claims.json')),
      confirmRuns: expected.confirmRuns,
      mode: 'worktree',
      budgetMs: 30_000,
      toolVersion: 'test',
    });
  }, 180_000);

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('yields every expected verdict, with the expected reason where one is stated', () => {
    const actual = Object.fromEntries(evidence.records.map((r) => [`${r.claim.id}/${r.subject.id}`, { verdict: r.verdict, reason: r.detail.reason }]));
    const wanted = Object.fromEntries(Object.entries(expected.expected).map(([k, v]) => [k, { verdict: v.verdict, reason: v.reason ?? actual[k]?.reason }]));
    expect(actual).toEqual(wanted);
  });

  it('emits evidence that conforms to the spec', () => {
    expect(validate('evidence', evidence).errors).toEqual([]);
  });

  it('ran in a scratch worktree and left the source tree untouched', () => {
    expect(evidence.run.mode).toBe('worktree');
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: scratch, encoding: 'utf8' }).stdout;
    expect(status).toBe('');
    expect(existsSync(join(scratch, '.testguard'))).toBe(false);
  });

  it('records N/N baseline and probe runs for killed and survived', () => {
    for (const r of evidence.records.filter((x) => x.verdict === 'killed' || x.verdict === 'survived')) {
      expect(r.detail.baselineRuns).toHaveLength(expected.confirmRuns);
      expect(r.detail.probeRuns).toHaveLength(expected.confirmRuns);
    }
  });

  it('escalated the survivors to the whole suite; the flaky test there did not get the credit', () => {
    const survivors = evidence.records.filter((x) => x.verdict === 'survived');
    expect(survivors).toHaveLength(2);
    for (const r of survivors) {
      expect(r.detail.escalated).toBe(true);
      expect(r.detail.reason).toBeUndefined();
      // flaky.test.mjs fails on alternate runs, so the intersection only empties on the 2nd run
      expect(r.detail.escalationRuns.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('ranks the critical survivor above the high one', () => {
    const by = Object.fromEntries(evidence.records.map((r) => [`${r.claim.id}/${r.subject.id}`, r.rank.score]));
    expect(by['REDACT-001/F1']).toBeGreaterThan(by['REDACT-003/F1']);
  });

  describe('then the other three commands, on the same repo', () => {
    it('claims: lists the file and finds no drift (REDACT-003 is annotated in source)', async () => {
      const { lines, io } = capture();
      expect(await main(['claims', scratch], io)).toBe(0);
      expect(lines.out.join('\n')).toContain('REDACT-001');
      expect(lines.out.join('\n')).toContain('NO DEFENDER');
      expect(lines.out.join('\n')).not.toMatch(/UNDECLARED|STALE/);
    });

    it('baseline: freezes every unproven finding and conforms', async () => {
      writeSpecDoc('evidence', join(scratch, '.testguard', 'evidence.json'), evidence);
      const { lines, io } = capture();
      expect(await main(['baseline', scratch], io)).toBe(0);
      expect(lines.out[0]).toMatch(/^baseline: 8 unproven findings frozen/);
      const b = readSpecDoc('baseline', join(scratch, '.testguard', 'baseline.json'));
      expect(Object.keys(b.fingerprints)).toHaveLength(8);
    });

    it('probe again: every verdict is reused (inputs unchanged) and nothing is new against the baseline → exit 0', async () => {
      const { lines, io } = capture();
      const started = Date.now();
      expect(await main(['probe', scratch, '--budget', '30000'], io)).toBe(0);
      expect(Date.now() - started).toBeLessThan(5000);
      const again = readSpecDoc('evidence', join(scratch, '.testguard', 'evidence.json'));
      expect(again.records.every((r) => r.reusedFrom === evidence.run.id)).toBe(true);
      expect(lines.out.join('\n')).toMatch(/0 new since baseline, 8 baselined/);
    }, 30_000);

    it('brief --text: prints the block without writing a file; new-since-baseline is zero', async () => {
      const { lines, io } = capture();
      expect(await main(['brief', scratch, '--text'], io)).toBe(0);
      const text = lines.out.join('\n');
      expect(text.startsWith('## TEST BLINDSPOT CONTEXT')).toBe(true);
      expect(text).toContain('0 new since baseline');
      expect(text).toContain('SURVIVED  REDACT-001/F1 (critical)');
      expect(text).not.toContain('[NEW]');
      expect(existsSync(join(scratch, '.testguard', 'brief.json'))).toBe(false);
      expect(validate('brief', (await import('../src/brief/brief.mjs')).buildBrief(evidence, readSpecDoc('baseline', join(scratch, '.testguard', 'baseline.json')))).ok).toBe(true);
    });

    it('brief --text on a repo with no evidence exits 0 silently, so a session-start hook never breaks', async () => {
      const { lines, io } = capture();
      expect(await main(['brief', mkdtempSync(join(tmpdir(), 'tg-empty-')), '--text'], io)).toBe(0);
      expect(lines.out).toEqual([]);
      expect(lines.err).toEqual([]);
    });
  });
});
