// @req NFR-03
import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probe } from '../src/probe/probe.mjs';
import { PreconditionError } from '../src/probe/worktree.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

it('refuses dirty defenders unless explicitly ignored, and records exactly what was ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-dirty-admission-'));
  try {
    mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src/value.mjs'), 'export const value = 1;\n');
    writeFileSync(join(dir, 'test/value.test.mjs'), "import { value } from '../src/value.mjs';\n");
    // Control the report protocol while exercising real git isolation and
    // dirty admission. Native Vitest execution remains in probe-preconditions.
    writeFileSync(join(dir, 'runner.cjs'), `const fs=require('node:fs');const pass=fs.readFileSync('src/value.mjs','utf8').includes('value = 1');fs.writeFileSync(process.argv.at(-1),JSON.stringify({success:pass,numTotalTests:1,numPassedTests:Number(pass),numFailedTests:Number(!pass),testResults:[{name:'test/value.test.mjs',assertionResults:[{status:pass?'passed':'failed',fullName:'value equals one',failureMessages:pass?[]:['AssertionError: expected one']}]}]}));`);
    for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']]) {
      execFileSync('git', [...FIXTURE_GIT, ...args], { cwd: dir, timeout: 5000 });
    }
    writeFileSync(join(dir, 'test/value.test.mjs'), "import { value } from '../src/value.mjs';\n// uncommitted\n");
    const claims = { schemaVersion: 1, claims: [{ id: 'DIRTY', statement: 'Value stays one.', source: { kind: 'manual' }, severity: 'low', defendedBy: ['test/value.test.mjs'], faults: [{ id: 'F1', description: 'Change value.', faultClass: 'literal-changed', file: 'src/value.mjs', find: 'value = 1', replace: 'value = 2' }] }] };
    const opts = { projectDir: dir, claims, mode: 'worktree', runnerCommand: `${JSON.stringify(process.execPath)} runner.cjs {files} {out}`, confirmRuns: 1, budgetMs: 3000, escalate: false };
    await expect(probe(opts)).rejects.toThrow(PreconditionError);
    await expect(probe(opts)).rejects.toThrow(/\(test\/value\.test\.mjs\).*probes HEAD \([a-f0-9]{7}\).*--ignore-dirty/s);
    const warnings = [];
    const evidence = await probe({ ...opts, ignoreDirty: true, onWarn: (message) => warnings.push(message) });
    expect(evidence.records[0].verdict).toBe('killed');
    expect(evidence.run.repo.ignoredDirty).toEqual(['test/value.test.mjs']);
    expect(evidence.run.repo.snapshot).toBeUndefined();
    expect(warnings.filter((message) => /uncommitted changes/.test(message))).toHaveLength(1);
    expect(warnings.find((message) => /uncommitted changes/.test(message))).toMatch(/test\/value\.test\.mjs.*probing HEAD \([a-f0-9]{7}\) as committed.*NOT what is being probed/s);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 15000);
