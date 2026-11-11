// @req FR-10
// The real CLI on a project whose only defender never asserts anything:
// probe, probe --json, status, brief, admit, --runner-cmd and legacy-evidence
// reuse. Slow (real probes), so it is a CI test and not a self-probe defender;
// the pure half is test/kill-kind.test.mjs.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main } from '../src/cli.mjs';
import { probe } from '../src/probe/probe.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { evaluateAssertionPolicy } from '../src/probe/assertion-policy.mjs';
import { readSpecDoc } from '../src/evidence/writer.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

    // No --no-reuse: the flag is a verdict over the records, not over a measurement, and the plain run above already
    // measured them (killKind rides along in a reused record; the legacy case below covers the one that has none).
    const strict = capture();
    expect(await main(['probe', dir, '--runner', 'vitest', '--no-escalate', '--require-assertion-kill'], strict.io)).toBe(1);
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

  it('legacy evidence (no killKind): re-measured on a tool-version change; if reused at the same version it keeps no kind and fails the policy', async () => {
    // The evidence the strict run above wrote, with the kind stripped: the shape a pre-killKind TestGuard left behind.
    const legacy = readSpecDoc('evidence', join(dir, '.testguard', 'evidence.json'));
    for (const r of legacy.records) { delete r.detail.killKind; for (const x of r.detail.probeRuns) delete x.exceptionFailures; }
    const options = { projectDir: dir, claims: loadClaims(join(dir, 'testguard.claims.json')), runnerName: 'vitest', confirmRuns: 3, budgetMs: 60_000, escalate: false };
    const sameVersion = await probe({ ...options, toolVersion: legacy.tool.version, previous: legacy });
    expect(sameVersion.records.map((r) => r.reusedFrom !== undefined)).toEqual([true, true]);
    expect(sameVersion.records.map((r) => r.detail.killKind)).toEqual([undefined, undefined]);
    expect(evaluateAssertionPolicy(sameVersion.records).state).toBe('failed');
    const newVersion = await probe({ ...options, toolVersion: '99.0.0', previous: legacy });
    expect(newVersion.records.map((r) => r.reusedFrom)).toEqual([undefined, undefined]);
    expect(newVersion.records.map((r) => r.detail.killKind).sort()).toEqual(['assertion', 'exception-only']);
  }, 240_000);

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

  it('--runner-cmd without failureDetails: both kills are exception-only because nothing could be read, said per kill', async () => {
    const vitestBin = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
    const cmd = `${process.execPath} ${vitestBin} run {files} --reporter=json --outputFile={out}`;
    const json = capture();
    expect(await main(['probe', dir, '--runner-cmd', cmd, '--no-escalate', '--no-reuse', '--require-assertion-kill', '--json'], json.io)).toBe(1);
    const doc = JSON.parse(json.l.out.join('\n'));
    expect(validate('status', doc).errors).toEqual([]);
    const reason = 'kind-not-reported-by-runner';
    expect(doc.run.assertionPolicy.exceptionOnlyKills).toEqual([{ claimId: 'P-ASSERT', faultId: 'F1', reason }, { claimId: 'P-CRASH', faultId: 'F1', reason }]);
    const evidence = readSpecDoc('evidence', join(dir, '.testguard', 'evidence.json'));
    expect(evidence.records.map((r) => [r.detail.killKind, r.detail.killKindReason])).toEqual([['exception-only', reason], ['exception-only', reason]]);
    // The text a user reads, from the CLI: the same measurement reused (the document above just wrote it), so one baseline run.
    const text = capture();
    await main(['probe', dir, '--runner-cmd', cmd, '--no-escalate', '--require-assertion-kill'], text.io);
    expect(text.l.out.join('\n')).toMatch(/P-ASSERT\/F1 \(kind-not-reported-by-runner: the runner reported no error identity/);
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
