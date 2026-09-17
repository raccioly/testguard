import { describe, it, expect, beforeEach } from 'vitest';
import { cpSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { computeRemovedClaims } from '../src/claims/removed.mjs';
import { main } from '../src/cli.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { fingerprint } from '../spec/lib/fingerprint.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'known-answer');
const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } };
};

/** The fixture as its own repository, with its claims file committed. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-since-'));
  cpSync(FIXTURE, dir, { recursive: true, filter: (s) => !/node_modules|\.flake-counter|\.testguard/.test(s) });
  const g = (...args) => {
    const r = spawnSync('git', ['-c', 'user.email=s@example.invalid', '-c', 'user.name=s', ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  g('init', '-q');
  g('add', '-A');
  g('commit', '-q', '-m', 'claims as committed');
  const claimsPath = join(dir, 'testguard.claims.json');
  const read = () => JSON.parse(readFileSync(claimsPath, 'utf8'));
  const write = (doc) => writeFileSync(claimsPath, JSON.stringify(doc, null, 2) + '\n');
  const ignore = (entries) => writeFileSync(join(dir, 'testguard.ignore.json'), JSON.stringify({ schemaVersion: 1, entries }, null, 2) + '\n');
  const run = (opts = {}) => computeRemovedClaims({ projectDir: dir, ref: 'HEAD', claimsPath, current: loadClaims(claimsPath), ...opts });
  return { dir, claimsPath, read, write, ignore, run };
}

describe('claims --since: a claim that disappeared is a finding', () => {
  let p;
  beforeEach(() => { p = project(); });

  it('reports a removed claim with its severity and fault ids, and exits 1 through the CLI', async () => {
    const doc = p.read();
    doc.claims = doc.claims.filter((c) => c.id !== 'REDACT-003');
    p.write(doc);
    const r = p.run();
    expect(r.findings).toEqual([{ kind: 'removed-claim', claimId: 'REDACT-003', severity: 'high', faults: ['F1'] }]);
    expect(r.removed).toHaveLength(1);

    const { lines, io } = capture();
    expect(await main(['claims', p.dir, '--since', 'HEAD'], io)).toBe(1);
    const text = lines.out.join('\n');
    expect(text).toMatch(/^REMOVED    REDACT-003 \(high, 1 fault\)$/m);
    expect(text).toContain('never silent');
  });

  it('names the verdict the claim last had, so "it was SURVIVED when it was removed" is on the record', () => {
    const doc = p.read();
    doc.claims = doc.claims.filter((c) => c.id !== 'REDACT-001');
    p.write(doc);
    const evidence = join(p.dir, 'ev.json');
    const pass = { outcome: 'pass', tests: { total: 1, passed: 1, failed: 0 }, assertionFailures: 0, durationMs: 1 };
    writeFileSync(evidence, JSON.stringify({
      schemaVersion: 1, tool: { name: 'testguard', version: 't' },
      run: { id: 'run-1', startedAt: '2026-09-17T00:00:00Z', finishedAt: '2026-09-17T00:00:01Z', repo: { head: 'a'.repeat(40), dirty: false }, runner: { name: 'vitest' }, confirmRuns: 3, mode: 'worktree' },
      records: [{
        fingerprint: fingerprint({ claimId: 'REDACT-001', subjectId: 'F1', file: 'src/redact.mjs', verdict: 'survived' }),
        claim: { id: 'REDACT-001', statement: 's', severity: 'critical', source: { kind: 'spec' } },
        subject: { kind: 'fault', id: 'F1', file: 'src/redact.mjs', faultClass: 'variable-swap' }, verdict: 'survived',
        detail: { baselineRuns: [pass, pass, pass], probeRuns: [pass, pass, pass] },
        defenders: { requested: ['test/redact.test.mjs'], resolved: ['test/redact.test.mjs'], nocover: false },
        inputs: { targetHash: 'b'.repeat(64), defenderHashes: { 'test/redact.test.mjs': 'c'.repeat(64) } },
      }],
    }));
    const r = p.run({ evidencePath: evidence });
    const removed = r.findings.find((f) => f.claimId === 'REDACT-001');
    expect(removed.lastVerdicts).toEqual(['survived']);
  });

  it('a removed fault on a surviving claim is its own finding', () => {
    const doc = p.read();
    const c = doc.claims.find((x) => x.id === 'REDACT-005');
    c.faults = c.faults.filter((f) => f.id !== 'F2');
    p.write(doc);
    const r = p.run();
    expect(r.findings).toEqual([{ kind: 'removed-fault', claimId: 'REDACT-005', subjectId: 'F2', severity: 'low' }]);
  });

  it('a rename with the same statement is not a removal', () => {
    const doc = p.read();
    const c = doc.claims.find((x) => x.id === 'REDACT-001');
    c.id = 'REDACT-001-AUDIT';
    p.write(doc);
    const r = p.run();
    expect(r.findings).toEqual([{ kind: 'renamed-claim', claimId: 'REDACT-001', renamedTo: 'REDACT-001-AUDIT', severity: 'critical' }]);
    expect(r.removed).toEqual([]);
  });

  it('an unexpired claim ignore entry excuses it and prints the reason; an expired one stops excusing', async () => {
    // REDACT-004 is spec-sourced: removing it creates no @claim annotation
    // drift, so the exit code here is about the removal and nothing else.
    const doc = p.read();
    doc.claims = doc.claims.filter((c) => c.id !== 'REDACT-004');
    p.write(doc);
    const reason = 'superseded by the wrapper-level claim; tracked in #99';
    p.ignore([{ kind: 'claim', pattern: 'REDACT-004', reason, by: 'maintainer' }]);
    const ok = p.run();
    expect(ok.removed).toEqual([]);
    expect(ok.reliedOn).toEqual([{ pattern: 'REDACT-004', reason, ids: ['REDACT-004'] }]);
    const a = capture();
    expect(await main(['claims', p.dir, '--since', 'HEAD'], a.io)).toBe(0);
    expect(a.lines.out.join('\n')).toMatch(/excused    REDACT-004  by ignore "REDACT-004": superseded/);

    p.ignore([{ kind: 'claim', pattern: 'REDACT-004', reason, expires: '2020-01-01T00:00:00Z' }]);
    const expired = p.run();
    expect(expired.removed).toHaveLength(1);
    expect(expired.removed[0].expiredExcuse).toBe('REDACT-004');
    const b = capture();
    expect(await main(['claims', p.dir, '--since', 'HEAD'], b.io)).toBe(1);
    expect(b.lines.out.join('\n')).toMatch(/EXPIRED    ignore "REDACT-004" \(expired 2020-01-01T00:00:00Z\)/);
  });

  it('a claim-level ignore also excuses one of that claim\'s faults being removed', () => {
    const doc = p.read();
    const c = doc.claims.find((x) => x.id === 'REDACT-005');
    c.faults = c.faults.filter((f) => f.id !== 'F2');
    p.write(doc);
    p.ignore([{ kind: 'claim', pattern: 'REDACT-005', reason: 'the ambiguous-anchor exhibit moved to its own fixture' }]);
    expect(p.run().removed).toEqual([]);
  });

  it('nothing removed → no findings, exit 0', async () => {
    expect(p.run().findings).toEqual([]);
    const { lines, io } = capture();
    expect(await main(['claims', p.dir, '--since', 'HEAD'], io)).toBe(0);
    expect(lines.out.join('\n')).toMatch(/every claim and fault present at HEAD still exists/);
  });

  it('a ref that does not resolve is a precondition failure, not a silent pass', async () => {
    const { lines, io } = capture();
    expect(await main(['claims', p.dir, '--since', 'no-such-ref'], io)).toBe(2);
    expect(lines.err.join('\n')).toMatch(/cannot read no-such-ref: no such commit/);
  });

  it('a ref where the claims file did not exist yet compares against nothing, and says so', () => {
    const r = computeRemovedClaims({ projectDir: p.dir, ref: 'HEAD', claimsPath: join(p.dir, 'nope.json'), current: loadClaims(p.claimsPath) });
    expect(r.comparedAgainst).toBe('nothing');
    expect(r.removed).toEqual([]);
  });
});
