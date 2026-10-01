import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../src/cli.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { writeSpecDoc } from '../src/evidence/writer.mjs';

async function invoke(args) {
  const out = [], err = [];
  const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
it.each([
  ['status', '--require-origin', 'spec'],
  ['probe', '--require-origin', 'spec,'],
  ['probe', '--require-origin', 'unknown'],
  ['probe', '--require-origin', 'spec', '--claim', 'C-1'],
  ['probe', '--require-origin', 'spec', '--confirm', '1'],
  ['probe', '--require-origin', 'spec', '--allow-empty'],
  ['probe', '--require-origin', 'spec', '--ref', 'HEAD'],
  ['probe', '--require-origin', 'spec', '--ignore-dirty'],
].map((args) => ({ args })))('refuses invalid policy request before loading nonexistent claims: %j', async ({ args }) => {
  const result = await invoke([...args, '--claims', '/nonexistent/testguard-policy-claims.json']);
  expect(result.code).toBe(3);
  expect(result.err).toContain('--require-origin');
  expect(result.err).not.toContain('cannot read claims');
});

it('actual native probe reports eligible/ineligible declarations and never baselines away a survivor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-origin-policy-cli-'));
  try {
    mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'checks'));
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n.testguard\n');
    writeFileSync(join(dir, 'src/value.mjs'), 'export const value = 1;\n');
    writeFileSync(join(dir, 'vitest.config.mjs'), "export default { test: { include: ['checks/*.case.mjs'] } };\n");
    writeFileSync(join(dir, 'checks/value.case.mjs'), "import { it, expect } from 'vitest'; import { value } from '../src/value.mjs'; it('value', () => expect(value).toBe(1));\n");
    const claims = { schemaVersion: 1, claims: [{ id: 'C-1', statement: 'Value is one.', severity: 'low', source: { kind: 'bug', ref: 'opaque-private-reference' }, producedBy: { producer: 'agent' }, defendedBy: ['checks/value.case.mjs'], faults: [{ id: 'F1', description: 'Change value.', file: 'src/value.mjs', faultClass: 'other', find: 'value = 1', replace: 'value = 2', producedBy: { producer: 'agent' } }] }] };
    writeSpecDoc('claims', join(dir, 'testguard.claims.json'), claims);
    for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'fixture']]) {
      const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw Error(r.stderr);
    }
    symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    const args = ['probe', dir, '--in-place', '--serial', '--no-escalate', '--runner', 'vitest', '--budget', '15000', '--json'];
    const run = async (extra) => {
      const result = await invoke([...args, ...extra]);
      expect(result.err).not.toContain('bug in testguard');
      const doc = JSON.parse(result.out);
      expect(validate('status', doc).errors).toEqual([]);
      expect(doc.run.exitCode).toBe(result.code);
      const evidence = JSON.parse(readFileSync(join(dir, '.testguard/evidence.json'), 'utf8'));
      expect(validate('evidence', evidence).errors).toEqual([]);
      return { ...result, doc, evidence };
    };
    const passed = await run(['--require-origin', 'spec,bug', '--require-origin', 'bug']);
    expect(passed.code, passed.err).toBe(0);
    expect(passed.doc.originPolicy).toMatchObject({ state: 'passed', eligibleKinds: ['bug', 'spec'], claims: 1, faults: 1 });
    expect(passed.doc.run.originPolicy).toEqual(passed.evidence.originPolicy);
    expect(passed.evidence.records[0].verdict).toBe('killed');
    const ineligible = await run(['--require-origin', 'incident']);
    expect(ineligible.code).toBe(1);
    expect(ineligible.evidence.originPolicy).toMatchObject({ state: 'failed', ineligibleClaims: ['C-1'], nonKilledFaults: [] });
    const disabled = await run([]);
    expect(disabled.code).toBe(0); expect(disabled.doc).not.toHaveProperty('originPolicy'); expect(disabled.evidence).not.toHaveProperty('originPolicy');
    writeFileSync(join(dir, 'checks/value.case.mjs'), "import { it, expect } from 'vitest'; import { value } from '../src/value.mjs'; it('value is positive', () => expect(value).toBeGreaterThan(0));\n");
    const survived = await run(['--require-origin', 'bug', '--severity', 'critical']);
    expect(survived.code).toBe(1); expect(survived.doc.run.newSinceBaseline).toBe(0);
    expect(survived.evidence.originPolicy).toMatchObject({ state: 'failed', nonKilledFaults: [{ claimId: 'C-1', faultId: 'F1' }] });
    await invoke(['baseline', dir]);
    const baselined = await run(['--require-origin', 'bug']);
    expect(baselined.doc.run.newSinceBaseline).toBe(0); expect(baselined.code).toBe(1);
    const unavailable = await run(['--require-origin', 'bug', '--runner-cmd', 'node node_modules/vitest/vitest.mjs run {files} --reporter=json --outputFile={out} --no-file-parallelism']);
    expect(unavailable.code).toBe(2);
    expect(unavailable.doc.originPolicy).toMatchObject({ state: 'unavailable', unavailableReasons: ['stale-inputs'], nonKilledFaults: [{ claimId: 'C-1', faultId: 'F1' }] });
    expect(readFileSync(join(dir, 'src/value.mjs'), 'utf8')).toBe('export const value = 1;\n');
    expect(existsSync(join(dir, '.testguard/evidence-provisional.json'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);
