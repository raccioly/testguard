// #320: Node reads `--test-reporter=tools/x.mjs` as a package name, so the defenders fail to load. The message says so.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from '../src/probe/probe.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { bareReporterHint } from '../src/probe/runners/shared.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const by = { producer: 'human', by: 'fixture' };
const CLAIMS = { schemaVersion: 1, claims: [{ id: 'VALUE-001', statement: 'The value is one.', source: { kind: 'spec', ref: 'fixture' }, severity: 'high', producedBy: by, defendedBy: ['test/guard.test.mjs'], faults: [{ id: 'F1', description: 'Change the value.', faultClass: 'literal-changed', file: 'src/guard.mjs', find: 'value = 1', replace: 'value = 2', producedBy: by }] }] };
const node = JSON.stringify(process.execPath);
let dir;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-reporter-hint-'));
  for (const d of ['src', 'test', 'tools']) mkdirSync(join(dir, d));
  writeFileSync(join(dir, 'src/guard.mjs'), 'export const value = 1;\n');
  writeFileSync(join(dir, 'test/guard.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { value } from '../src/guard.mjs';\ntest('one', () => assert.equal(value, 1));\n");
  writeFileSync(join(dir, 'tools/reporter.mjs'), 'export default async function* reporter(source) { for await (const _ of source) { /* never reached under a bare path */ } }\n');
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(CLAIMS, null, 2));
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=f@example.invalid', '-c', 'user.name=f', 'commit', '-qm', 'fixture']]) execFileSync('git', [...FIXTURE_GIT, ...args], { cwd: dir, timeout: 5000 });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('bareReporterHint', () => {
  const hint = (cmd) => bareReporterHint(cmd, dir);
  it('names a bare relative path that exists as a file, in both spellings of the flag', () => {
    expect(hint('node --test --test-reporter=tools/reporter.mjs {files} {out}')).toBe('Node reads `tools/reporter.mjs` as a package name; write `./tools/reporter.mjs`.');
    expect(hint('node --test --test-reporter tools/reporter.mjs {files} {out}')).toBe('Node reads `tools/reporter.mjs` as a package name; write `./tools/reporter.mjs`.');
    expect(hint('node --test "--test-reporter=tools/reporter.mjs" {files} {out}')).toContain('write `./tools/reporter.mjs`');
  });
  it('says nothing for a path that already starts with ./, ../, / or file:, or a node: builtin', () => {
    for (const value of ['./tools/reporter.mjs', '../tools/reporter.mjs', join(dir, 'tools/reporter.mjs'), `file://${join(dir, 'tools/reporter.mjs')}`, 'node:test/reporters']) {
      expect(hint(`node --test --test-reporter=${value} {files} {out}`), value).toBeUndefined();
    }
  });
  it('says nothing for a real package name, or a value that is not a file here, or a directory', () => {
    for (const value of ['spec', 'tap', 'tools', 'tools/missing.mjs']) expect(hint(`node --test --test-reporter=${value} {files} {out}`), value).toBeUndefined();
  });
  it('says nothing without a reporter flag, without a command, or for a command that does not parse', () => {
    expect(hint('node --test {files} {out}')).toBeUndefined();
    expect(hint(undefined)).toBeUndefined();
    expect(hint('node --test --test-reporter')).toBeUndefined();
    expect(hint('node "--test-reporter=tools/reporter.mjs {files}')).toBeUndefined();
  });
});

describe('a probe whose runner command has a bare reporter path (#320)', () => {
  it('ends defenders-failed-to-load and the record says what to write instead', async () => {
    const runnerCommand = `${node} --test --test-reporter=tools/reporter.mjs --test-reporter-destination={out} {files}`;
    const ev = await probe({ projectDir: dir, claims: loadClaims(join(dir, 'testguard.claims.json')), confirmRuns: 1, mode: 'worktree', budgetMs: 30_000, runnerCommand, escalate: false, toolVersion: 'test' });
    const record = ev.records[0];
    expect(record.verdict).toBe('unverifiable');
    expect(record.detail.reason).toBe('defenders-failed-to-load');
    expect(record.detail.message).toContain('Node reads `tools/reporter.mjs` as a package name; write `./tools/reporter.mjs`.');
    expect(validate('evidence', ev).errors).toEqual([]);
  }, 60_000);
});
