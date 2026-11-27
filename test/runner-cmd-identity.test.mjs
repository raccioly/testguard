// A `--runner-cmd` runs a command TestGuard did not choose (#332). Three things
// follow, and each used to be wrong for a suite that is not JavaScript:
// the evidence named the fallback adapter (vitest) as the runner that ran, the
// test universe held only that adapter's globs so escalation never had a test
// to ask, and nobody was told it had been skipped.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { customCommandRunner, commandUniverse, sameRunner, probe } from '../src/probe/probe.mjs';
import { escalationPlan } from '../src/probe/attribution.mjs';
import { hashCustomCommandUniverse } from '../src/probe/universe.mjs';
import { parseCommandTemplate } from '../src/probe/runners/shared.mjs';
import { renderRecord } from '../src/render.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const example = () => JSON.parse(readFileSync(new URL('../spec/conformance/examples/evidence.json', import.meta.url), 'utf8'));
const template = (text) => parseCommandTemplate(text);

describe('the evidence names the runner that ran', () => {
  it('records a custom command as custom-command with the hash of its parsed words, and no version or source', () => {
    const record = customCommandRunner(template('mvn-glue.sh {out} {files}'));
    expect(record).toEqual({ name: 'custom-command', commandHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(customCommandRunner(template('mvn-glue.sh   {out}   {files}'))).toEqual(record);
    expect(customCommandRunner(template('mvn-glue.sh --fast {out} {files}')).commandHash).not.toBe(record.commandHash);
  });

  it('never reuses evidence measured by another command, nor by a native runner of any name', () => {
    const a = customCommandRunner(template('glue.sh {out} {files}'));
    const b = customCommandRunner(template('glue.sh --other {out} {files}'));
    expect(sameRunner({ runner: a }, a)).toBe(true);
    expect(sameRunner({ runner: a }, b)).toBe(false);
    expect(sameRunner({ runner: { name: 'vitest', version: '5.0.1' } }, a)).toBe(false);
    expect(sameRunner({ runner: { name: 'custom-command' } }, a)).toBe(false);
  });

  it('binds the adapter that reads the report into the universe hash, so another adapter re-measures', () => {
    const words = template('glue.sh {out} {files}');
    const files = ['test/GuardTest.java'];
    expect(hashCustomCommandUniverse(files, words, 'vitest')).not.toBe(hashCustomCommandUniverse(files, words, 'jest'));
    expect(hashCustomCommandUniverse(files, words, 'vitest')).toBe(hashCustomCommandUniverse(files, words, 'vitest'));
  });

  it('the schema and validator accept the new record and refuse a half-made one', () => {
    const evidence = example();
    const hash = 'a'.repeat(64);
    evidence.run.runner = { name: 'custom-command', commandHash: hash };
    if (evidence.run.runners) evidence.run.runners = [{ name: 'custom-command' }];
    expect(validate('evidence', evidence).errors).toEqual([]);
    for (const runner of [
      { name: 'custom-command' }, // no hash
      { name: 'custom-command', commandHash: 'xyz' }, // not a sha256
      { name: 'custom-command', commandHash: hash, version: '5.0.1' }, // a command resolves nothing
      { name: 'custom-command', commandHash: hash, source: 'project' },
      { name: 'vitest', version: '5.0.1', commandHash: hash }, // a native runner has no command
    ]) {
      evidence.run.runner = runner;
      expect(validate('evidence', evidence).ok, JSON.stringify(runner)).toBe(false);
    }
  });
});

describe('the custom-command test universe', () => {
  it('holds the declared defenders as well as the adapter globs, once each and sorted', () => {
    expect(commandUniverse([], ['test/DiscountTest.java', 'test/CartTest.java'])).toEqual(['test/CartTest.java', 'test/DiscountTest.java']);
    expect(commandUniverse(['test/a.test.mjs', 'test/b.test.mjs'], ['test/b.test.mjs', 'test/CartTest.java'])).toEqual(['test/CartTest.java', 'test/a.test.mjs', 'test/b.test.mjs']);
  });
});

describe('escalation says why it did not run', () => {
  const base = { verdict: 'survived', subjectReached: undefined, escalate: true, broaderCount: 2 };
  it('runs when a survivor has tests outside its defenders', () => {
    expect(escalationPlan(base)).toBe('run');
    expect(escalationPlan({ ...base, subjectReached: true })).toBe('run');
  });
  it('is skipped, and recorded, when the universe has no test outside the defenders', () => {
    expect(escalationPlan({ ...base, broaderCount: 0 })).toBe('skipped-no-test-outside-defenders');
  });
  it('records nothing where nothing was owed: --no-escalate, a kill, an unexecuted subject', () => {
    expect(escalationPlan({ ...base, broaderCount: 0, escalate: false })).toBe('none');
    expect(escalationPlan({ ...base, verdict: 'killed', broaderCount: 0 })).toBe('none');
    expect(escalationPlan({ ...base, subjectReached: false, broaderCount: 0 })).toBe('none');
  });

  it('the record, the schema and the console line carry the skip', () => {
    const evidence = example();
    const survivor = evidence.records.find((r) => r.verdict === 'survived');
    expect(survivor).toBeDefined();
    survivor.detail.escalationSkipped = 'no-test-outside-defenders';
    delete survivor.detail.escalated;
    expect(validate('evidence', evidence).errors).toEqual([]);
    expect(renderRecord(survivor)).toMatch(/\[escalation skipped: the test universe has no test outside the defenders\]/);

    survivor.detail.escalated = true;
    expect(validate('evidence', evidence).ok).toBe(false); // it either ran or was skipped
    delete survivor.detail.escalated;
    survivor.detail.escalationSkipped = 'something-else';
    expect(validate('evidence', evidence).ok).toBe(false);
    survivor.detail.escalationSkipped = 'no-test-outside-defenders';
    survivor.verdict = 'killed';
    expect(validate('evidence', evidence).ok).toBe(false); // only a survivor was owed an escalation
  });
});

// A suite no JavaScript runner lists: the report comes from a small script.
const REPORTER = `const fs=require('node:fs');const out=process.argv.at(-1);const files=process.argv.slice(2,-1);
const src=fs.readFileSync('src/Guard.java','utf8');
const results=files.map((f)=>{const ok=f.endsWith('GuardTest.java')?!src.includes('testguard negative control'):src.includes('value = 1');
return {name:f,assertionResults:[{status:ok?'passed':'failed',fullName:'t',failureMessages:ok?[]:['AssertionError: expected one']}]};});
const failed=results.filter((r)=>r.assertionResults[0].status==='failed').length;
fs.writeFileSync(out,JSON.stringify({success:!failed,numTotalTests:results.length,numPassedTests:results.length-failed,numFailedTests:failed,testResults:results}));`;
const by = { producer: 'human', by: 'fixture' };
const claim = (id, defendedBy, faults = []) => ({ id, statement: `The ${id} value is one.`, source: { kind: 'spec', ref: 'fixture' }, severity: 'high', producedBy: by, defendedBy, faults });
const fault = { id: 'F1', description: 'Change the value.', faultClass: 'literal-changed', file: 'src/Guard.java', find: 'value = 1', replace: 'value = 2', producedBy: by };
const dirs = [];
const fixture = (claims, tests) => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-runner-cmd-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src/Guard.java'), 'class Guard { int value = 1; }\n');
  for (const t of tests) writeFileSync(join(dir, 'test', t), 'class T {}\n');
  writeFileSync(join(dir, 'runner.cjs'), REPORTER);
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify({ schemaVersion: 1, claims }, null, 2));
  writeFileSync(join(dir, '.gitignore'), '.testguard/\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']]) {
    execFileSync('git', [...FIXTURE_GIT, ...args], { cwd: dir, timeout: 5000 });
  }
  return dir;
};
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const runProbe = (dir) => probe({
  projectDir: dir, claims: loadClaims(join(dir, 'testguard.claims.json')), confirmRuns: 1, budgetMs: 10_000,
  runnerCommand: `${JSON.stringify(process.execPath)} runner.cjs {files} {out}`,
});

describe('a --runner-cmd probe of a suite no JavaScript runner lists', () => {
  it('escalates to another claim\'s declared test, and records the command as the runner', async () => {
    const dir = fixture([claim('GUARD', ['test/GuardTest.java'], [fault]), claim('OTHER', ['test/OtherTest.java'], [fault])], ['GuardTest.java', 'OtherTest.java']);
    const evidence = await runProbe(dir);
    expect(evidence.run.runner).toEqual({ name: 'custom-command', commandHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const record = evidence.records[0];
    expect(record.verdict).toBe('survived');
    expect(record.detail.escalated).toBe(true);
    expect(record.detail.reason).toBe('killed-by-undeclared-tests');
    expect(record.detail.undeclaredKillers).toEqual(['test/OtherTest.java::t']);
    expect(record.detail).not.toHaveProperty('escalationSkipped');
    expect(validate('evidence', evidence).errors).toEqual([]);
  }, 30_000);

  it('says so, in the record and on the console line, when no test lies outside the defenders', async () => {
    const dir = fixture([claim('GUARD', ['test/GuardTest.java'], [fault])], ['GuardTest.java']);
    const evidence = await runProbe(dir);
    const record = evidence.records[0];
    expect(record.verdict).toBe('survived');
    expect(record.detail.escalationSkipped).toBe('no-test-outside-defenders');
    expect(record.detail).not.toHaveProperty('escalated');
    expect(renderRecord(record)).toContain('[escalation skipped: the test universe has no test outside the defenders]');
    expect(validate('evidence', evidence).errors).toEqual([]);
  }, 30_000);
});
