import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { computeStatus, renderStatus, faultContentHash } from '../src/status/status.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { computeStatus, faultContentHash } from '../src/status/status.mjs';
import { writeSpecDoc } from '../src/evidence/writer.mjs';
import { buildBaseline } from '../src/baseline/baseline.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { hashFile } from '../src/util/hash.mjs';
import { fingerprint } from '../spec/lib/fingerprint.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'known-answer');

/** Turn a project directory into a one-commit repository so a change can be measured. */
function gitInit(dir) {
  const g = (...args) => {
    const r = spawnSync('git', ['-c', 'user.email=s@example.invalid', '-c', 'user.name=s', ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'base');
}

/** A copy of the fixture we can mutate, with helpers to fabricate evidence that matches its current inputs. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-status-'));
  cpSync(FIXTURE, dir, { recursive: true, filter: (s) => !/node_modules|\.flake-counter|\.testguard/.test(s) });
  const claims = JSON.parse(readFileSync(join(dir, 'testguard.claims.json'), 'utf8'));
  const pass = { outcome: 'pass', tests: { total: 4, passed: 4, failed: 0 }, assertionFailures: 0, durationMs: 1 };
  const fail = { outcome: 'fail', tests: { total: 4, passed: 3, failed: 1 }, assertionFailures: 1, durationMs: 1 };
  const evidence = (verdictOf) => ({
    schemaVersion: 1, tool: { name: 'testguard', version: 't' },
    run: { id: 'run-1', startedAt: '2026-09-17T00:00:00Z', repo: { head: 'a'.repeat(40), dirty: false }, confirmRuns: 3, mode: 'worktree' },
    records: claims.claims.flatMap((c) => c.faults.map((f) => {
      const verdict = verdictOf(c, f);
      const defenders = c.defendedBy ?? ['test/redact.test.mjs'];
      const resolved = defenders.filter((d) => { try { readFileSync(join(dir, d)); return true; } catch { return false; } });
      const runs = verdict === 'killed' ? [fail, fail, fail] : verdict === 'survived' ? [pass, pass, pass] : [];
      return {
        fingerprint: fingerprint({ claimId: c.id, subjectId: f.id, file: f.file, verdict }),
        claim: { id: c.id, statement: c.statement, severity: c.severity, source: c.source },
        subject: { kind: 'fault', id: f.id, file: f.file, faultClass: f.faultClass, contentHash: faultContentHash(f) },
        verdict,
        detail: { ...(verdict === 'nocover' ? {} : verdict === 'unverifiable' ? { reason: 'anchor-missing' } : {}), baselineRuns: runs.length ? [pass, pass, pass] : [], probeRuns: runs },
        defenders: { requested: defenders, resolved: verdict === 'nocover' ? [] : resolved, nocover: verdict === 'nocover' },
        inputs: { targetHash: hashFile(join(dir, f.file)), defenderHashes: Object.fromEntries((verdict === 'nocover' ? [] : resolved).map((d) => [d, hashFile(join(dir, d))])) },
        rank: { score: c.severity === 'critical' ? 8 : 4 },
      };
    })),
  });
  return { dir, claims, evidence };
}

describe('computeStatus — every state, with a conforming document', () => {
  it('no-claims → scaffold', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-empty-'));
    const s = computeStatus({ projectDir: dir });
    expect(s).toMatchObject({ state: 'no-claims', next: { action: 'scaffold' } });
    expect(validate('status', s).errors).toEqual([]);
  });
  it('unprobed → probe', () => {
    const { dir } = project();
    const s = computeStatus({ projectDir: dir });
    expect(s).toMatchObject({ state: 'unprobed', next: { action: 'probe', command: 'testguard probe' }, counts: { claims: 11, faults: 14 } });
    expect(validate('status', s).errors).toEqual([]);
  });
  it('provisional-only → probe --confirm 3', () => {
    const { dir, evidence } = project();
    const ev = evidence(() => 'killed'); ev.run.confirmRuns = 1; ev.run.provisional = true;
    for (const r of ev.records) { r.detail.baselineRuns = r.detail.baselineRuns.slice(0, 1); r.detail.probeRuns = r.detail.probeRuns.slice(0, 1); }
    writeSpecDoc('evidence', join(dir, '.testguard', 'evidence-provisional.json'), ev);
    const s = computeStatus({ projectDir: dir });
    expect(s).toMatchObject({ state: 'provisional-only', provisional: true, next: { command: 'testguard probe --confirm 3' } });
    expect(validate('status', s).errors).toEqual([]);
  });
  it('unproven → write-test targeting the top NEW finding, with a concrete command', () => {
    const { dir, evidence } = project();
    writeSpecDoc('evidence', join(dir, '.testguard', 'evidence.json'), evidence((c, f) => (c.id === 'REDACT-001' && f.id === 'F1' ? 'survived' : 'killed')));
    const s = computeStatus({ projectDir: dir });
    expect(s.state).toBe('unproven');
    expect(s.next).toMatchObject({ action: 'write-test', target: { claimId: 'REDACT-001', subjectId: 'F1', verdict: 'survived' } });
    expect(s.next.command).toMatch(/^write a test in test\/redact\.test\.mjs that fails on REDACT-001\/F1 .* testguard admit test\/redact\.test\.mjs --claim REDACT-001$/);
    expect(s.findings[0]).toMatchObject({ claimId: 'REDACT-001', isNew: true });
    expect(validate('status', s).errors).toEqual([]);
  });
  it('unverifiable → fix the fault definition, not the code', () => {
    const { dir, evidence } = project();
    writeSpecDoc('evidence', join(dir, '.testguard', 'evidence.json'), evidence((c, f) => (c.id === 'REDACT-005' && f.id === 'F1' ? 'unverifiable' : 'killed')));
    const s = computeStatus({ projectDir: dir });
    expect(s.next.action).toBe('probe');
    expect(s.next.command).toMatch(/^edit REDACT-005\/F1 in testguard\.claims\.json/);
  });
  it('clean with unproven-but-baselined → none; clean with no baseline → baseline', () => {
    const { dir, evidence } = project();
    const ev = evidence((c, f) => (c.id === 'REDACT-003' ? 'survived' : 'killed'));
    writeSpecDoc('evidence', join(dir, '.testguard', 'evidence.json'), ev);
    expect(computeStatus({ projectDir: dir })).toMatchObject({ state: 'unproven' });
    writeSpecDoc('baseline', join(dir, '.testguard', 'baseline.json'), buildBaseline(ev));
    const s = computeStatus({ projectDir: dir });
    expect(s).toMatchObject({ state: 'clean', next: { action: 'none' }, counts: { new: 0, baselined: 1 } });
    expect(validate('status', s).errors).toEqual([]);
    const all = evidence(() => 'killed');
    writeSpecDoc('evidence', join(dir, '.testguard', 'evidence.json'), all);
    rmSync(join(dir, '.testguard', 'baseline.json'));
    expect(computeStatus({ projectDir: dir }).next.why).toMatch(/Every claim is defended/);
  });
  it('evidence-stale when a target or defender changed; changedFaults when a fault was edited after it survived', () => {
    const { dir, evidence } = project();
    writeSpecDoc('evidence', join(dir, '.testguard', 'evidence.json'), evidence((c, f) => (c.id === 'REDACT-003' ? 'survived' : 'killed')));
    writeFileSync(join(dir, 'test', 'redact.test.mjs'), readFileSync(join(dir, 'test', 'redact.test.mjs'), 'utf8') + '\n// edit\n');
    let s = computeStatus({ projectDir: dir });
    expect(s.state).toBe('evidence-stale');
    expect(s.stale.some((x) => /redact\.test\.mjs changed/.test(x))).toBe(true);
    expect(s.next).toMatchObject({ action: 'probe', command: 'testguard probe --include-dirty' });

    // now weaken the surviving fault: the cheapest way to make it "die" without a test
    const claims = JSON.parse(readFileSync(join(dir, 'testguard.claims.json'), 'utf8'));
    const c = claims.claims.find((x) => x.id === 'REDACT-003');
    c.faults[0].replace = 'if (!ctx) {';
    writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(claims));
    s = computeStatus({ projectDir: dir });
    expect(s.changedFaults).toEqual([{ claimId: 'REDACT-003', subjectId: 'F1', previousVerdict: 'survived', file: 'src/redact.mjs' }]);
    expect(s.next).toMatchObject({ action: 'review-fault-change', target: { claimId: 'REDACT-003', verdict: 'survived' } });
    expect(s.next.why).toMatch(/weakened fault/);
    expect(validate('status', s).errors).toEqual([]);
  });
  it('unclaimed-changes precedes every evidence state when a reference is known, and names the file; no-claims points scaffold at it', () => {
    const { dir, evidence } = project();
    gitInit(dir);
    writeSpecDoc('evidence', join(dir, '.testguard', 'evidence.json'), evidence((c, f) => (c.id === 'REDACT-001' && f.id === 'F1' ? 'survived' : 'killed')));
    expect(computeStatus({ projectDir: dir, changedRef: 'HEAD', includeDirty: true }).state).toBe('unproven'); // nothing changed yet
    writeFileSync(join(dir, 'src', 'newfeature.mjs'), 'export const f = () => 1;\n');
    const s = computeStatus({ projectDir: dir, changedRef: 'HEAD', includeDirty: true });
    expect(s.state).toBe('unclaimed-changes');
    expect(s.next).toMatchObject({ action: 'claim', command: 'testguard scaffold src/newfeature.mjs --claim REDACT-001', file: 'src/newfeature.mjs' });
    expect(s.next.why).toMatch(/1 changed file since HEAD carries no claim/);
    expect(s.changes).toMatchObject({ ref: 'HEAD', changed: 2, evaluated: 1, excluded: 1, uncovered: [{ file: 'src/newfeature.mjs', kind: 'source' }] }); // the untracked .testguard/evidence.json is a change too, excluded by default
    expect(validate('status', s).errors).toEqual([]);
    expect(computeStatus({ projectDir: dir }).state).toBe('unproven'); // without a reference, nothing about the change is claimed to be known

    rmSync(join(dir, 'testguard.claims.json'));
    const none = computeStatus({ projectDir: dir, changedRef: 'HEAD', includeDirty: true });
    expect(none).toMatchObject({ state: 'no-claims', next: { action: 'scaffold', command: 'testguard scaffold src/newfeature.mjs', file: 'src/newfeature.mjs' } });
    expect(validate('status', none).errors).toEqual([]);
  });
  it('a baseline frozen from a snapshot or a dirty tree, once HEAD moved on, is a note — never a state', () => {
    const { dir, evidence } = project();
    gitInit(dir);
    const ev = evidence((c) => (c.id === 'REDACT-003' ? 'survived' : 'killed'));
    writeSpecDoc('evidence', join(dir, '.testguard', 'evidence.json'), ev);
    const b = buildBaseline(ev);
    // freeze as if from a snapshot of a parent commit, then let HEAD move on
    writeSpecDoc('baseline', join(dir, '.testguard', 'baseline.json'), { ...b, head: 'a'.repeat(40), dirty: true, snapshot: 'b'.repeat(40) });
    const s = computeStatus({ projectDir: dir });
    expect(s.state).toBe('clean');
    expect(s.notes).toHaveLength(1);
    expect(s.notes[0]).toMatch(/frozen from a working-tree snapshot at aaaaaaa; HEAD is [0-9a-f]{7}.*baseline --restamp/);
    expect(validate('status', s).errors).toEqual([]);
    // a clean baseline at HEAD itself: no note
    const { spawnSync } = require('node:child_process');
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    writeSpecDoc('baseline', join(dir, '.testguard', 'baseline.json'), { ...b, head, dirty: false });
    expect(computeStatus({ projectDir: dir }).notes).toEqual([]);
    // a clean baseline at a commit that is NOT in HEAD's history (rewritten or foreign): a different note
    writeSpecDoc('baseline', join(dir, '.testguard', 'baseline.json'), { ...b, head: 'd'.repeat(40), dirty: false });
    expect(computeStatus({ projectDir: dir }).notes).toEqual([expect.stringMatching(/baseline head ddddddd is not an ancestor of HEAD/)]);
  });
});

describe("evidence from elsewhere (CI's, fetched as an artifact)", () => {
  it('is read with --evidence, marked provided, names the commit it describes and this tree, and is still checked for staleness', () => {
    const { dir, evidence } = project();
    gitInit(dir);
    const ev = evidence(() => 'killed');
    ev.run.repo.head = 'c'.repeat(40); // CI probed another commit
    const foreign = join(dir, 'ci-evidence.json');
    writeSpecDoc('evidence', foreign, ev);
    const s = computeStatus({ projectDir: dir, evidence: foreign });
    expect(s.evidenceSource).toBe('provided');
    expect(s.evidenceHead).toBe('c'.repeat(40));
    expect(s.head).toMatch(/^[a-f0-9]{40}$/);
    expect(s.head).not.toBe(s.evidenceHead);
    expect(s.stale).toEqual([]); // inputs still match, so the verdicts hold
    expect(validate('status', s).errors).toEqual([]);
    expect(renderStatus(s)).toMatch(/^evidence: ci-evidence\.json \(provided\) describes ccccccc; this tree is [a-f0-9]{7}$/m);

    // a target that changed since CI probed it goes stale, exactly as for a local run
    writeFileSync(join(dir, 'src', 'redact.mjs'), readFileSync(join(dir, 'src', 'redact.mjs'), 'utf8') + '\n// local edit\n');
    const s2 = computeStatus({ projectDir: dir, evidence: foreign });
    expect(s2.state).toBe('evidence-stale');
    expect(s2.stale.some((x) => /src\/redact\.mjs changed since/.test(x))).toBe(true);
    expect(validate('status', s2).errors).toEqual([]);
  });
  it('local evidence is marked local and still records the commit it describes', () => {
    const { dir, evidence } = project();
    writeSpecDoc('evidence', join(dir, '.testguard', 'evidence.json'), evidence(() => 'killed'));
    const s = computeStatus({ projectDir: dir });
    expect(s.evidenceSource).toBe('local');
    expect(s.evidenceHead).toBe('a'.repeat(40));
    expect(renderStatus(s)).not.toContain('(provided)');
    expect(validate('status', s).errors).toEqual([]);
  });
});
