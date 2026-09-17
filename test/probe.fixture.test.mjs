import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, symlinkSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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

  it('records every fault\'s content hash so a later edit is visible', () => {
    for (const r of evidence.records) expect(r.subject.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('discovers defenders by import when none are declared, and records that it did', () => {
    const r = evidence.records.find((x) => x.claim.id === 'DISCOVER-001');
    expect(r.verdict).toBe('killed');
    expect(r.defenders).toMatchObject({ requested: [], resolved: ['test/redact.test.mjs'], nocover: false, discovered: true });
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
      expect(lines.out[0]).toContain('1 carry a @claim annotation');
      expect(lines.out.find((l) => l.includes('REDACT-003'))).toMatch(/^@ REDACT-003/);
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

    it('--claim probes only the named claims and writes PARTIAL evidence beside, not over, the canonical file', async () => {
      const { lines, io } = capture();
      const before = readSpecDoc('evidence', join(scratch, '.testguard', 'evidence.json')).records.length;
      // the baseline frozen above already holds REDACT-001/F1, so nothing is new → exit 0
      expect(await main(['probe', scratch, '--claim', 'REDACT-001', '--budget', '30000', '--quiet'], io)).toBe(0);
      const partial = readSpecDoc('evidence', join(scratch, '.testguard', 'evidence-partial.json'));
      expect(partial.records.map((r) => r.claim.id)).toEqual(['REDACT-001', 'REDACT-001']);
      expect(readSpecDoc('evidence', join(scratch, '.testguard', 'evidence.json')).records).toHaveLength(before);
      expect(lines.out.join('\n')).toContain('partial: --claim REDACT-001');
      expect(validate('evidence', partial).ok).toBe(true);
    }, 60_000);

    it('--claim with an unknown id is a precondition failure', async () => {
      const { lines, io } = capture();
      expect(await main(['probe', scratch, '--claim', 'NOPE-1', '--quiet'], io)).toBe(2);
      expect(lines.err.join('\n')).toMatch(/unknown claim id/);
    });

    it('a runner that cannot run the defenders yields UNVERIFIABLE (defenders-failed-to-load), never flaky-defender', async () => {
      const failing = `${process.execPath} -e process.exit(3) {files} {out}`;
      const ev = await probe({ projectDir: scratch, claims: loadClaims(join(scratch, 'testguard.claims.json')), confirmRuns: 3, mode: 'worktree', budgetMs: 30_000, runnerCommand: failing, escalate: false, toolVersion: 'test' });
      const verdicts = new Set(ev.records.map((r) => r.verdict));
      expect(verdicts.has('flaky-defender')).toBe(false);
      expect(verdicts.has('killed')).toBe(false);
      const withDefenders = ev.records.filter((x) => x.defenders.resolved.length > 0);
      for (const r of withDefenders) expect(r.verdict).toBe('unverifiable');
      // anchor problems are detected before the defenders are ever run; everything else is the load failure
      const reasons = withDefenders.map((r) => r.detail.reason);
      expect(reasons.filter((x) => x === 'defenders-failed-to-load').length).toBeGreaterThanOrEqual(6);
      expect(new Set(reasons.filter((x) => x !== 'defenders-failed-to-load'))).toEqual(new Set(['anchor-missing', 'anchor-ambiguous']));
      expect(validate('evidence', ev).errors).toEqual([]);
    }, 120_000);

    it('default output lists only unproven faults plus a killed count; --verbose lists everything', async () => {
      const a = capture();
      await main(['probe', scratch, '--claim', 'REDACT-001', '--budget', '30000', '--no-reuse'], a.io);
      expect(a.lines.out.some((l) => /^killed/.test(l))).toBe(false);
      expect(a.lines.out.join('\n')).toMatch(/1 killed \(not listed; --verbose to see them\)/);
      const b = capture();
      await main(['probe', scratch, '--claim', 'REDACT-001', '--budget', '30000', '--verbose'], b.io);
      expect(b.lines.out.some((l) => /^killed\s+REDACT-001\/F2/.test(l))).toBe(true);
    }, 90_000);

    it('refuses worktree mode when a defender has uncommitted changes, naming it and the probed commit', async () => {
      const file = join(scratch, 'test', 'redact.test.mjs');
      const original = readFileSync(file, 'utf8');
      writeFileSync(file, original + '\n// uncommitted edit\n');
      try {
        await expect(probe({ projectDir: scratch, claims: loadClaims(join(scratch, 'testguard.claims.json')), confirmRuns: 3, mode: 'worktree', budgetMs: 30_000, toolVersion: 'test' }))
          .rejects.toThrow(/test\/redact\.test\.mjs.*probes HEAD.*--include-dirty/s);
      } finally {
        writeFileSync(file, original);
      }
    });

    it('--include-dirty probes the working tree: an uncommitted test that kills a survivor turns it killed, HEAD untouched', async () => {
      const file = join(scratch, 'test', 'redact.test.mjs');
      const original = readFileSync(file, 'utf8');
      const headBefore = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: scratch, encoding: 'utf8' }).stdout.trim();
      writeFileSync(file, original + `
it('fails closed on a missing scope (uncommitted)', async () => {
  await expect(redact('x', RULES, {}, { writeAudit: vi.fn() })).rejects.toThrow(/scope/);
});
`);
      try {
        const ev = await probe({ projectDir: scratch, claims: loadClaims(join(scratch, 'testguard.claims.json')), confirmRuns: 3, mode: 'worktree', includeDirty: true, only: ['REDACT-003'], escalate: false, budgetMs: 30_000, toolVersion: 'test' });
        expect(ev.records).toHaveLength(1);
        expect(ev.records[0].verdict).toBe('killed');
        expect(ev.run.repo.snapshot).toMatch(/^[a-f0-9]{40}$/);
        expect(ev.run.repo.head).toBe(headBefore);
        expect(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: scratch, encoding: 'utf8' }).stdout.trim()).toBe(headBefore);
        expect(validate('evidence', ev).errors).toEqual([]);
      } finally {
        writeFileSync(file, original);
      }
    }, 120_000);

    it('baseline records whether the tree was dirty', () => {
      const b = readSpecDoc('baseline', join(scratch, '.testguard', 'baseline.json'));
      expect(typeof b.dirty).toBe('boolean');
    });

    it('--confirm 1 is provisional: warns, writes evidence-provisional.json (canonical untouched), marks verdicts, and baseline refuses it unless allowed', async () => {
      const canonicalBefore = readFileSync(join(scratch, '.testguard', 'evidence.json'), 'utf8');
      const a = capture();
      const code = await main(['probe', scratch, '--confirm', '1', '--budget', '30000', '--no-escalate'], a.io);
      expect([0, 1]).toContain(code);
      expect(a.lines.err.join('\n')).toMatch(/^PROVISIONAL — confirmRuns 1/m);
      expect(a.lines.out.join('\n')).toMatch(/SURVIVED\?/);
      expect(a.lines.out.join('\n')).toMatch(/evidence-provisional\.json \(provisional/);
      expect(readFileSync(join(scratch, '.testguard', 'evidence.json'), 'utf8')).toBe(canonicalBefore);
      const prov = readSpecDoc('evidence', join(scratch, '.testguard', 'evidence-provisional.json'));
      expect(prov.run).toMatchObject({ confirmRuns: 1, provisional: true });
      expect(prov.records.every((r) => !r.reusedFrom)).toBe(true); // a confirmed prior is never reused by a provisional run

      const b = capture();
      expect(await main(['baseline', scratch, '--evidence', join(scratch, '.testguard', 'evidence-provisional.json'), '--out', join(scratch, '.testguard', 'b-prov.json')], b.io)).toBe(2);
      expect(b.lines.err.join('\n')).toMatch(/provisional.*--allow-provisional/s);
      const c = capture();
      expect(await main(['baseline', scratch, '--evidence', join(scratch, '.testguard', 'evidence-provisional.json'), '--out', join(scratch, '.testguard', 'b-prov.json'), '--allow-provisional'], c.io)).toBe(0);
      expect(c.lines.out[0]).toContain('FROM PROVISIONAL EVIDENCE');
    }, 120_000);

    it('status --json and probe --json emit a conforming status document with a next action; brief carries it', async () => {
      const a = capture();
      const code = await main(['status', scratch, '--json'], a.io);
      const status = JSON.parse(a.lines.out.join('\n'));
      expect(validate('status', status).errors).toEqual([]);
      expect(['clean', 'unproven', 'evidence-stale']).toContain(status.state);
      expect([0, 1]).toContain(code);
      expect(status.next.action).toBeDefined();
      const b = capture();
      await main(['brief', scratch, '--json'], b.io);
      const brief = JSON.parse(b.lines.out.join('\n'));
      expect(validate('brief', brief).errors).toEqual([]);
      expect(brief.next.action).toBe(status.next.action);
      expect(brief.text).toContain(`NEXT [${status.next.action}]`);
      const c = capture();
      const pc = await main(['probe', scratch, '--claim', 'REDACT-001', '--budget', '30000', '--json'], c.io);
      const out = JSON.parse(c.lines.out.join('\n'));
      expect(out.run).toMatchObject({ records: 2, exitCode: pc });
      expect(out.state).toBeDefined();
    }, 90_000);

    it('brief --text on a repo with no evidence exits 0 silently, so a session-start hook never breaks', async () => {
      const { lines, io } = capture();
      expect(await main(['brief', mkdtempSync(join(tmpdir(), 'tg-empty-')), '--text'], io)).toBe(0);
      expect(lines.out).toEqual([]);
      expect(lines.err).toEqual([]);
    });
  });
});
