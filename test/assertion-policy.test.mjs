// @req FR-10
// The kill kind and the --require-assertion-kill policy. The first half is
// pure; the second drives the real CLI on a project whose only defender never
// asserts anything.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main } from '../src/cli.mjs';
import { classify } from '../src/probe/classify.mjs';
import { isKillRun, killKindOf, killingFailures } from '../src/probe/kill-kind.mjs';
import { assertionPolicyRequest, evaluateAssertionPolicy, isWeakKill, renderAssertionPolicy } from '../src/probe/assertion-policy.mjs';
import { renderRecord } from '../src/render.mjs';
import { readSpecDoc } from '../src/evidence/writer.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (assertionFailures, exceptionFailures, extra = {}) => ({ outcome: 'fail', assertionFailures, exceptionFailures, timeouts: 0, ...extra });
const pass = { outcome: 'pass', assertionFailures: 0, exceptionFailures: 0, timeouts: 0 };

describe('killKindOf — pure', () => {
  it('assertion: every run had an assertion failure', () => expect(killKindOf([run(1, 0), run(2, 1), run(1, 0)])).toBe('assertion'));
  it('exception-only: no run had one', () => expect(killKindOf([run(0, 1), run(0, 3), run(0, 1)])).toBe('exception-only'));
  it('mixed: some runs had one', () => expect(killKindOf([run(1, 0), run(0, 1), run(1, 0)])).toBe('mixed'));
  it('nothing to classify without a kill run', () => {
    expect(killKindOf([])).toBeUndefined();
    expect(killKindOf([pass, pass])).toBeUndefined();
    expect(killKindOf([{ outcome: 'fail', assertionFailures: 0, exceptionFailures: 0, timeouts: 1 }])).toBeUndefined();
  });
  it('legacy runs without exceptionFailures read as assertion kills', () => expect(killKindOf([{ outcome: 'fail', assertionFailures: 2 }])).toBe('assertion'));
  it('a kill is the sum; a timeout or a pass is not one', () => {
    expect(killingFailures(run(1, 2))).toBe(3);
    expect(isKillRun(run(0, 1))).toBe(true);
    expect(isKillRun(run(1, 0))).toBe(true);
    expect(isKillRun(run(0, 0))).toBe(false);
    expect(isKillRun({ ...pass })).toBe(false);
    expect(isKillRun({ outcome: 'error', assertionFailures: 1, exceptionFailures: 1 })).toBe(false);
  });
});

describe('classify — the default verdict is unchanged; the kind rides along', () => {
  const base = { defenders: ['t'], anchor: { status: 'ok' }, baselineRuns: [pass, pass, pass], confirmRuns: 3 };
  it('an exception-only kill is still killed', () => {
    expect(classify({ ...base, probeRuns: [run(0, 1), run(0, 1), run(0, 1)] })).toEqual({ verdict: 'killed', killKind: 'exception-only' });
  });
  it('an assertion kill and a mixed kill are killed with their kind', () => {
    expect(classify({ ...base, probeRuns: [run(1, 0), run(1, 0), run(1, 0)] })).toEqual({ verdict: 'killed', killKind: 'assertion' });
    expect(classify({ ...base, probeRuns: [run(1, 0), run(0, 1), run(1, 0)] })).toEqual({ verdict: 'killed', killKind: 'mixed' });
  });
  it('a failing run with neither kind of failure never kills', () => {
    expect(classify({ ...base, probeRuns: [run(0, 0), pass, pass] }).verdict).toBe('flaky-defender');
  });
});

describe('--require-assertion-kill policy — pure', () => {
  const rec = (claimId, faultId, verdict, killKind) => ({ claim: { id: claimId }, subject: { id: faultId }, verdict, detail: killKind ? { killKind } : {} });
  it('fails on exception-only and on a kill with no recorded kind; passes assertion and mixed; ignores non-kills', () => {
    const records = [rec('B', 'F1', 'killed', 'exception-only'), rec('A', 'F2', 'killed', 'assertion'), rec('A', 'F1', 'killed'), rec('C', 'F1', 'killed', 'mixed'), rec('D', 'F1', 'survived')];
    expect(evaluateAssertionPolicy(records)).toEqual({ state: 'failed', exceptionOnlyKills: [{ claimId: 'A', faultId: 'F1' }, { claimId: 'B', faultId: 'F1' }] });
    expect(isWeakKill(rec('D', 'F1', 'survived'))).toBe(false);
  });
  it('passes when every kill has an assertion', () => {
    expect(evaluateAssertionPolicy([rec('A', 'F1', 'killed', 'assertion')])).toEqual({ state: 'passed', exceptionOnlyKills: [] });
    expect(evaluateAssertionPolicy([])).toEqual({ state: 'passed', exceptionOnlyKills: [] });
  });
  it('is valid only on probe and admit', () => {
    expect(assertionPolicyRequest({}, 'status')).toBe(false);
    expect(assertionPolicyRequest({ 'require-assertion-kill': true }, 'probe')).toBe(true);
    expect(assertionPolicyRequest({ 'require-assertion-kill': true }, 'admit')).toBe(true);
    expect(() => assertionPolicyRequest({ 'require-assertion-kill': true }, 'status')).toThrow(/only valid on probe and admit/);
  });
  it('names the faults beside the failure', () => {
    expect(renderAssertionPolicy({ state: 'failed', exceptionOnlyKills: [{ claimId: 'A', faultId: 'F1' }] })).toMatch(/failed; 1 kill was by exception only.*A\/F1/);
    expect(renderAssertionPolicy({ state: 'passed', exceptionOnlyKills: [] })).toMatch(/passed/);
  });
  it('a rendered record says when it was killed by exception only, and only then', () => {
    const r = (killKind) => ({ verdict: 'killed', claim: { id: 'A', severity: 'high' }, subject: { id: 'F1', file: 'f.mjs', description: 'd' }, detail: { killKind }, defenders: {} });
    expect(renderRecord(r('exception-only'))).toContain('killed by exception only');
    expect(renderRecord(r('assertion'))).not.toContain('exception only');
    expect(renderRecord(r('mixed'))).not.toContain('exception only');
  });
});

describe('the real CLI: a defender with no assertion, a fault that throws', () => {
  const dirs = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const capture = () => { const l = { out: [], err: [] }; return { l, io: { out: (s) => l.out.push(s), err: (s) => l.err.push(s) } }; };
  const git = (cwd, ...args) => { const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=f@example.invalid', '-c', 'user.name=f', ...args], { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
  const project = () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-policy-'));
    dirs.push(dir);
    const files = {
      'package.json': '{"name":"p","private":true,"type":"module"}\n',
      'src/f.mjs': 'export function f(x) {\n  return x + 1;\n}\n',
      'test/crash.test.mjs': "import { test } from 'vitest';\nimport { f } from '../src/f.mjs';\ntest('runs', () => { f(1); });\n",
      'test/assert.test.mjs': "import { test, expect } from 'vitest';\nimport { f } from '../src/f.mjs';\ntest('adds', () => { expect(f(1)).toBe(2); });\n",
    };
    for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
    const producedBy = { producer: 'agent', by: 'test' };
    const fault = (find, replace) => [{ id: 'F1', description: 'd', faultClass: 'other', file: 'src/f.mjs', find, replace, producedBy }];
    writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify({ schemaVersion: 1, claims: [
      { id: 'P-CRASH', statement: 'f works.', source: { kind: 'spec', ref: 'README.md' }, severity: 'high', producedBy, defendedBy: ['test/crash.test.mjs'], faults: fault('  return x + 1;', "  throw new Error('boom');") },
      { id: 'P-ASSERT', statement: 'f adds.', source: { kind: 'spec', ref: 'README.md' }, severity: 'high', producedBy, defendedBy: ['test/assert.test.mjs'], faults: fault('  return x + 1;', '  return x + 2;') },
    ] }));
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n.testguard\n');
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'p');
    return dir;
  };
  let dir;

  it('probe: exit 0 by default, killKind recorded; with the flag exit 1, verdict still killed, the kill named', async () => {
    dir = project();
    const plain = capture();
    expect(await main(['probe', dir, '--runner', 'vitest', '--no-escalate'], plain.io)).toBe(0);
    const evidence = readSpecDoc('evidence', join(dir, '.testguard', 'evidence.json'));
    expect(Object.fromEntries(evidence.records.map((r) => [r.claim.id, [r.verdict, r.detail.killKind]]))).toEqual({ 'P-CRASH': ['killed', 'exception-only'], 'P-ASSERT': ['killed', 'assertion'] });
    expect(evidence.assertionPolicy).toBeUndefined();
    expect(plain.l.out.join('\n')).toMatch(/1 of 2 kills are by crash, not by assertion/);

    const strict = capture();
    expect(await main(['probe', dir, '--runner', 'vitest', '--no-escalate', '--no-reuse', '--require-assertion-kill'], strict.io)).toBe(1);
    const text = strict.l.out.join('\n');
    expect(text).toMatch(/killed\s+P-CRASH\/F1.*killed by exception only/);
    expect(text).toMatch(/assertion policy: failed; 1 kill was by exception only.*P-CRASH\/F1/);
    expect(text).not.toMatch(/P-ASSERT\/F1.*exception only/);
    const written = readSpecDoc('evidence', join(dir, '.testguard', 'evidence.json'));
    expect(written.assertionPolicy).toEqual({ state: 'failed', exceptionOnlyKills: [{ claimId: 'P-CRASH', faultId: 'F1' }] });
    expect(written.records.map((r) => r.verdict)).toEqual(['killed', 'killed']);
  }, 120_000);

  it('probe --json carries the policy in run and exits 1 with a valid status document', async () => {
    const json = capture();
    expect(await main(['probe', dir, '--runner', 'vitest', '--no-escalate', '--require-assertion-kill', '--json'], json.io)).toBe(1);
    const doc = JSON.parse(json.l.out.join('\n'));
    expect(validate('status', doc).errors).toEqual([]);
    expect(doc.run.exitCode).toBe(1);
    expect(doc.run.assertionPolicy).toEqual({ state: 'failed', exceptionOnlyKills: [{ claimId: 'P-CRASH', faultId: 'F1' }] });
    expect(doc.counts.killedExceptionOnly).toBe(1);
  }, 120_000);

  it('status names the exception-only count as a weakness; brief does too', async () => {
    const status = capture();
    await main(['status', dir], status.io);
    expect(status.l.out.join('\n')).toMatch(/1 of 2 kills are by crash, not by assertion/);
    const brief = capture();
    await main(['brief', dir, '--json'], brief.io);
    const doc = JSON.parse(brief.l.out.join('\n'));
    expect(validate('brief', doc).errors).toEqual([]);
    expect(doc.summary.killedExceptionOnly).toBe(1);
    expect(doc.text).toMatch(/1 of 2 kills are by crash, not by assertion/);
  }, 60_000);

  it('admit: a test that only crashes the fault is admitted by default and refused with the flag', async () => {
    const file = join(dir, 'test', 'crash.test.mjs');
    const ok = capture();
    expect(await main(['admit', file, '--claim', 'P-CRASH', '--runner', 'vitest'], ok.io)).toBe(0);
    expect(ok.l.out.join('\n')).toMatch(/ADMITTED/);
    const strict = capture();
    expect(await main(['admit', file, '--claim', 'P-CRASH', '--runner', 'vitest', '--require-assertion-kill', '--json'], strict.io)).toBe(1);
    const out = JSON.parse(strict.l.out.join('\n'));
    expect(out).toMatchObject({ admitted: false, assertionPolicy: { state: 'failed' }, faults: [{ id: 'F1', verdict: 'killed', killKind: 'exception-only' }] });
    const asserting = capture();
    expect(await main(['admit', join(dir, 'test', 'assert.test.mjs'), '--claim', 'P-ASSERT', '--runner', 'vitest', '--require-assertion-kill'], asserting.io)).toBe(0);
  }, 180_000);

  it('the flag is refused on every other command, exit 3', async () => {
    const c = capture();
    expect(await main(['status', dir, '--require-assertion-kill'], c.io)).toBe(3);
    expect(c.l.err.join('\n')).toMatch(/only valid on probe and admit/);
  });

  it('a pre-kind evidence record that was reused fails the policy: unknown rounds toward unproven', () => {
    const legacy = { claim: { id: 'L' }, subject: { id: 'F1' }, verdict: 'killed', detail: {} };
    expect(evaluateAssertionPolicy([legacy]).state).toBe('failed');
  });
});
