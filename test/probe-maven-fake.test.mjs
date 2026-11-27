// A whole probe through the maven adapter, against a fake `mvnw` (#329). The
// fake does what the issue's Java project did under a real Maven: 2 faults
// killed, 1 survived, and a compile error where the negative control breaks the
// file. It was not run against a real Maven in this tree.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probe } from '../src/probe/probe.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const dirs = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const MVNW = `#!${process.execPath}
const fs = require('fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('Apache Maven 3.9.6 (fake)'); process.exit(0); }
const source = fs.readFileSync('src/main/java/demo/Discount.java', 'utf8');
if (source.includes('testguard negative control')) {
  console.log('[ERROR] COMPILATION ERROR :\\n[ERROR] /w/src/main/java/demo/Discount.java:[1,1] illegal start of expression\\n[INFO] BUILD FAILURE');
  process.exit(1);
}
const classes = argv.find((a) => a.startsWith('-Dtest=')).slice(7).split(',');
fs.mkdirSync('target/surefire-reports', { recursive: true });
let failed = false;
for (const cls of classes) {
  const cases = [['memberGetsTenPercent', source.includes('if (member) {')], ['rejectsNegative', source.includes('if (price < 0) {')]];
  const body = cases.map(([name, ok]) => ok ? '<testcase name="' + name + '()" classname="' + cls + '"/>'
    : '<testcase name="' + name + '()" classname="' + cls + '"><failure message="expected" type="org.opentest4j.AssertionFailedError">x</failure></testcase>').join('');
  if (cases.some(([, ok]) => !ok)) failed = true;
  fs.writeFileSync('target/surefire-reports/TEST-' + cls + '.xml', '<testsuite name="' + cls + '" tests="2">' + body + '</testsuite>');
}
process.exit(failed ? 1 : 0);
`;

const project = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-maven-probe-')));
  dirs.push(dir);
  mkdirSync(join(dir, 'src/main/java/demo'), { recursive: true });
  mkdirSync(join(dir, 'src/test/java/demo'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), 'target/\n.testguard/\n');
  writeFileSync(join(dir, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion></project>\n');
  writeFileSync(join(dir, 'mvnw'), MVNW);
  chmodSync(join(dir, 'mvnw'), 0o755);
  writeFileSync(join(dir, 'src/main/java/demo/Discount.java'), [
    'package demo;', '', 'public class Discount {',
    '    public static int apply(int price, boolean member) {',
    '        if (price < 0) {', '            throw new IllegalArgumentException("negative price");', '        }',
    '        if (member) {', '            return price * 90 / 100;', '        }',
    '        return price;', '    }', '}', '',
  ].join('\n'));
  writeFileSync(join(dir, 'src/test/java/demo/DiscountTest.java'), 'package demo;\nclass DiscountTest {}\n');
  const by = { producer: 'human', by: 'fixture' };
  const fault = (id, description, find, replace) => ({ id, description, faultClass: 'condition-forced', file: 'src/main/java/demo/Discount.java', find, replace, producedBy: by });
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify({ schemaVersion: 1, claims: [{
    id: 'DISCOUNT', statement: 'Members pay 90% and a negative price is rejected.', source: { kind: 'spec', ref: 'fixture' }, severity: 'high', producedBy: by,
    defendedBy: ['src/test/java/demo/DiscountTest.java'],
    faults: [
      fault('F1', 'the negative guard never fires', '        if (price < 0) {', '        if (false) {'),
      fault('F2', 'members get no discount', '        if (member) {', '        if (false) {'),
      fault('F3', 'the error message is lost', '"negative price"', '""'),
    ],
  }] }));
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']]) {
    execFileSync('git', [...FIXTURE_GIT, ...args], { cwd: dir, timeout: 5000 });
  }
  return dir;
};

describe('a probe of a Maven project through --runner maven', () => {
  it('kills two faults, leaves one surviving, and records maven as the runner', async () => {
    const dir = project();
    const evidence = await probe({
      projectDir: dir, claims: loadClaims(join(dir, 'testguard.claims.json')), confirmRuns: 1, budgetMs: 30_000, runnerName: 'maven',
    });
    expect(evidence.run.runner).toEqual({ name: 'maven', version: '3.9.6', source: 'project' });
    const verdicts = Object.fromEntries(evidence.records.map((r) => [r.subject.id, r.verdict]));
    expect(verdicts).toEqual({ F1: 'killed', F2: 'killed', F3: 'survived' });
    expect(evidence.records.find((r) => r.subject.id === 'F1').detail?.killKind).toBe('assertion');
    expect(validate('evidence', evidence).errors).toEqual([]);
  }, 60_000);
});
