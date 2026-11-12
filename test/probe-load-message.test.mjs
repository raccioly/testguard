import { it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probe } from '../src/probe/probe.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

// #291: 71 records were `unverifiable` / `defenders-failed-to-load` with only a `reason`.
// The runner's words reached `anchor.message` and stopped there; the record never carried them.
const by = { producer: 'human', by: 'fixture' };
const CLAIMS = { schemaVersion: 1, claims: [{ id: 'VALUE-001', statement: 'The value is one.', source: { kind: 'spec', ref: 'fixture' }, severity: 'high', producedBy: by, defendedBy: ['test/guard.test.mjs'], faults: [{ id: 'F1', description: 'Change the value.', faultClass: 'literal-changed', file: 'src/guard.mjs', find: 'value = 1', replace: 'value = 2', producedBy: by }] }] };
let dir;
const node = JSON.stringify(process.execPath);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-load-message-'));
  mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src/guard.mjs'), 'export const value = 1;\n');
  writeFileSync(join(dir, 'test/guard.test.mjs'), "import {value} from '../src/guard.mjs';\n");
  writeFileSync(join(dir, 'zero.cjs'), "require('node:fs').writeFileSync(process.argv.at(-1), JSON.stringify({success:false,numTotalTests:0,numPassedTests:0,numFailedTests:0,testResults:[]}));");
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(CLAIMS, null, 2));
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=f@example.invalid', '-c', 'user.name=f', 'commit', '-qm', 'fixture']]) execFileSync('git', [...FIXTURE_GIT, ...args], { cwd: dir, timeout: 5000 });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('a defender set that fails to load says why in the record, not only in the reason', async () => {
  const ev = await probe({ projectDir: dir, claims: loadClaims(join(dir, 'testguard.claims.json')), confirmRuns: 1, mode: 'worktree', budgetMs: 30_000, runnerCommand: `${node} zero.cjs {files} {out}`, escalate: false, toolVersion: 'test' });
  const record = ev.records[0];
  expect(record.verdict).toBe('unverifiable');
  expect(record.detail.reason).toBe('defenders-failed-to-load');
  expect(record.detail.message).toMatch(/collected no tests/);
  expect(validate('evidence', ev).errors).toEqual([]);
}, 60_000);
