// `--report-format junit` (#329): a `--runner-cmd` whose report is JUnit XML,
// read without a hand-written converter. The option is a usage contract, it
// is part of what the evidence says ran, and it is the same on every command
// that runs tests.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runnerOptions } from '../src/commands/runner-options.mjs';
import { customCommandRunner, sameRunner, probe } from '../src/probe/probe.mjs';
import { hashCustomCommandUniverse } from '../src/probe/universe.mjs';
import { parseCommandTemplate, runProcess } from '../src/probe/runners/shared.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { readProjectConfig } from '../src/config/project-config.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const template = (text) => parseCommandTemplate(text);
const example = () => JSON.parse(readFileSync(new URL('../spec/conformance/examples/evidence.json', import.meta.url), 'utf8'));
const capture = () => { const lines = { out: [], err: [] }; return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } }; };
const dirs = [];
const tmp = (prefix) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe('--report-format is a usage contract', () => {
  const cmd = 'node r.cjs {files} {out}';
  it('passes jest and junit through, and defaults to nothing', () => {
    expect(runnerOptions({ 'runner-cmd': cmd, 'report-format': 'junit' })).toMatchObject({ runnerCommand: cmd, reportFormat: 'junit' });
    expect(runnerOptions({ 'runner-cmd': cmd, 'report-format': 'jest' })).toMatchObject({ reportFormat: 'jest' });
    expect(runnerOptions({ 'runner-cmd': cmd }).reportFormat).toBeUndefined();
    expect(runnerOptions({}).error).toBeUndefined();
  });

  it('refuses an unknown value and says what is known', () => {
    expect(runnerOptions({ 'runner-cmd': cmd, 'report-format': 'tap' }).error).toMatch(/--report-format must be jest or junit/);
    expect(runnerOptions({ 'runner-cmd': cmd, 'report-format': '' }).error).toMatch(/--report-format must be jest or junit/);
  });

  it('refuses the flag without --runner-cmd: it says how to read a command\'s report', () => {
    expect(runnerOptions({ 'report-format': 'junit' }).error).toMatch(/--report-format needs --runner-cmd/);
  });

  for (const name of ['probe', 'admit', 'sweep', 'replay']) {
    it(`is exit 3 on ${name}`, async () => {
      const dir = tmp('tg-report-format-');
      writeFileSync(join(dir, 'a.test.mjs'), '');
      const argv = {
        probe: ['probe', dir], admit: ['admit', join(dir, 'a.test.mjs'), '--claim', 'X-001'],
        sweep: ['sweep', dir, '--changed', 'HEAD'], replay: ['replay', dir, '--since', 'HEAD~1..HEAD'],
      }[name];
      const { main } = await import('../src/cli.mjs');
      for (const extra of [['--report-format', 'tap', '--runner-cmd', cmd], ['--report-format', 'junit']]) {
        const { lines, io } = capture();
        expect(await main([...argv, ...extra], io)).toBe(3);
        expect(lines.err.join('\n')).toMatch(/--report-format/);
      }
    });
  }
});

describe('reportFormat in testguard.config.json', () => {
  const read = (config) => readProjectConfig('.', { source: JSON.stringify({ schemaVersion: 1, ...config }) });
  it('accepts junit and jest and refuses anything else', () => {
    expect(read({ runnerCmd: 'x {files} {out}', reportFormat: 'junit' }).config.reportFormat).toBe('junit');
    expect(() => read({ runnerCmd: 'x {files} {out}', reportFormat: 'tap' })).toThrow(/reportFormat/);
  });
});

describe('the evidence names the report format of a custom command', () => {
  const words = template('mvn-glue.sh {out} {files}');
  it('records junit beside the command hash, and records nothing for the jest default', () => {
    expect(customCommandRunner(words)).toEqual({ name: 'custom-command', commandHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(customCommandRunner(words, 'jest')).toEqual(customCommandRunner(words));
    expect(customCommandRunner(words, 'junit')).toEqual({ ...customCommandRunner(words), reportFormat: 'junit' });
  });

  it('never reuses a measurement read as another format', () => {
    const jest = customCommandRunner(words);
    const junit = customCommandRunner(words, 'junit');
    expect(sameRunner({ runner: junit }, junit)).toBe(true);
    expect(sameRunner({ runner: jest }, junit)).toBe(false);
    expect(sameRunner({ runner: junit }, jest)).toBe(false);
  });

  it('binds the format into the universe hash, and leaves the jest hash as it was', () => {
    const files = ['test/GuardTest.java'];
    const jest = hashCustomCommandUniverse(files, words, 'vitest');
    expect(hashCustomCommandUniverse(files, words, 'vitest', 'jest')).toBe(jest);
    expect(hashCustomCommandUniverse(files, words, 'vitest', 'junit')).not.toBe(jest);
  });

  it('the schema and validator accept it on a custom command only', () => {
    const evidence = example();
    const hash = 'a'.repeat(64);
    if (evidence.run.runners) evidence.run.runners = [{ name: 'custom-command' }];
    evidence.run.runner = { name: 'custom-command', commandHash: hash, reportFormat: 'junit' };
    expect(validate('evidence', evidence).errors).toEqual([]);
    for (const runner of [
      { name: 'custom-command', commandHash: hash, reportFormat: 'jest' }, // the default is never recorded
      { name: 'custom-command', commandHash: hash, reportFormat: 'tap' },
      { name: 'vitest', version: '5.0.1', reportFormat: 'junit' }, // a native runner reads its own report
    ]) {
      evidence.run.runner = runner;
      if (evidence.run.runners) evidence.run.runners = [{ name: runner.name, ...(runner.version ? { version: runner.version } : {}) }];
      expect(validate('evidence', evidence).ok, JSON.stringify(runner)).toBe(false);
    }
    // the native runner is refused for the field itself, not for some other disagreement
    evidence.run.runner = { name: 'vitest', version: '5.0.1', reportFormat: 'junit' };
    if (evidence.run.runners) evidence.run.runners = [{ name: 'vitest', version: '5.0.1' }];
    expect(validate('evidence', evidence).errors).toEqual([{ path: '/run/runner', message: expect.stringMatching(/reportFormat is recorded only for a custom command/) }]);
  });
});

// A command that writes what Surefire writes: one file, or a directory of them, at {out}.
const WRITER = `const fs=require('node:fs');const path=require('node:path');
const [mode,out]=process.argv.slice(2,4);const files=process.argv.slice(4);
const bad=fs.readFileSync('src/Guard.java','utf8').includes('value = 2');
const suite=(name)=>'<testsuite name="'+name+'" tests="1" errors="0" failures="'+(bad?1:0)+'"><testcase name="holds" classname="'+name+'">'+(bad?'<failure message="expected: 1" type="org.opentest4j.AssertionFailedError"/>':'')+'</testcase></testsuite>';
if(mode==='none'){process.stderr.write('COMPILATION ERROR');process.exit(1);}
if(mode==='file'){fs.writeFileSync(out,suite('GuardTest'));}
if(mode==='dir'){fs.mkdirSync(out);for(const f of files)fs.writeFileSync(path.join(out,'TEST-'+path.basename(f,'.java')+'.xml'),suite(path.basename(f,'.java')));}
process.exit(bad?1:0);`;

describe('runProcess reads the report in the named format', () => {
  const run = (mode, extra = {}) => {
    const dir = tmp('tg-junit-run-');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/Guard.java'), `class Guard { int value = ${extra.value ?? 1}; }\n`);
    writeFileSync(join(dir, 'writer.cjs'), WRITER);
    return runProcess({
      projectDir: dir, files: ['test/GuardTest.java', 'test/CartTest.java'], budgetMs: 10_000,
      commandTemplate: template(`${JSON.stringify(process.execPath)} writer.cjs ${mode} {out} {files}`), reportFormat: 'junit',
    });
  };

  it('a single XML file at {out}', async () => {
    const result = await run('file');
    expect(result.run).toMatchObject({ outcome: 'pass', tests: { total: 1, passed: 1, failed: 0 } });
  });

  it('a directory of reports at {out}, which the scratch cleanup removes', async () => {
    const result = await run('dir');
    expect(result.run).toMatchObject({ outcome: 'pass', tests: { total: 2, passed: 2, failed: 0 } });
  });

  it('a failing test is a kill read from the type attribute', async () => {
    const result = await run('dir', { value: 2 });
    expect(result.run).toMatchObject({ outcome: 'fail', assertionFailures: 2, exceptionFailures: 0 });
  });

  it('no report and a non-zero exit stays an error with the runner\'s own words', async () => {
    const result = await run('none');
    expect(result.run.outcome).toBe('error');
    expect(result.loadMessage).toMatch(/COMPILATION ERROR/);
  });

  it('an unreadable report is an error that says so', async () => {
    const dir = tmp('tg-junit-run-');
    writeFileSync(join(dir, 'w.cjs'), 'require("node:fs").writeFileSync(process.argv[2], "this is not xml")');
    const result = await runProcess({ projectDir: dir, files: ['t'], budgetMs: 10_000, commandTemplate: template(`${JSON.stringify(process.execPath)} w.cjs {out} {files}`), reportFormat: 'junit' });
    expect(result.run.outcome).toBe('error');
    expect(result.loadMessage).toMatch(/unreadable report: not a JUnit XML report/);
  });
});

const junitProject = () => {
  const dir = tmp('tg-junit-probe-');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src/Guard.java'), 'class Guard { int value = 1; }\n');
  writeFileSync(join(dir, 'test/GuardTest.java'), 'class T {}\n');
  writeFileSync(join(dir, 'writer.cjs'), WRITER);
  const by = { producer: 'human', by: 'fixture' };
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify({ schemaVersion: 1, claims: [{
    id: 'GUARD', statement: 'The value is one.', source: { kind: 'spec', ref: 'fixture' }, severity: 'high', producedBy: by, defendedBy: ['test/GuardTest.java'],
    faults: [{ id: 'F1', description: 'Change the value.', faultClass: 'literal-changed', file: 'src/Guard.java', find: 'value = 1', replace: 'value = 2', producedBy: by }],
  }] }));
  writeFileSync(join(dir, '.gitignore'), '.testguard/\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']]) {
    execFileSync('git', [...FIXTURE_GIT, ...args], { cwd: dir, timeout: 5000 });
  }
  return dir;
};
const command = `${JSON.stringify(process.execPath)} writer.cjs dir {out} {files}`;

describe('a --runner-cmd probe with --report-format junit', () => {
  it('kills a fault from XML alone, and records the format', async () => {
    const dir = junitProject();
    const evidence = await probe({
      projectDir: dir, claims: loadClaims(join(dir, 'testguard.claims.json')), confirmRuns: 1, budgetMs: 10_000,
      runnerCommand: command, reportFormat: 'junit',
    });
    expect(evidence.run.runner).toEqual({ name: 'custom-command', commandHash: expect.stringMatching(/^[0-9a-f]{64}$/), reportFormat: 'junit' });
    expect(evidence.records[0].verdict).toBe('killed');
    expect(validate('evidence', evidence).errors).toEqual([]);
  }, 30_000);

  it('the same through the CLI, and from testguard.config.json', async () => {
    const { main } = await import('../src/cli.mjs');
    const dir = junitProject();
    const flagged = capture();
    expect(await main(['probe', dir, '--runner-cmd', command, '--report-format', 'junit', '--no-escalate'], flagged.io)).toBe(0);
    const evidence = JSON.parse(readFileSync(join(dir, '.testguard/evidence.json'), 'utf8'));
    expect(evidence.run.runner.reportFormat).toBe('junit');
    expect(evidence.records[0].verdict).toBe('killed');

    // The same options from the file carry the verdict forward: nothing is re-measured.
    rmSync(join(dir, '.testguard'), { recursive: true, force: true });
    writeFileSync(join(dir, 'testguard.config.json'), JSON.stringify({ schemaVersion: 1, runnerCmd: command, reportFormat: 'junit' }));
    execFileSync('git', [...FIXTURE_GIT, 'add', '.'], { cwd: dir });
    execFileSync('git', [...FIXTURE_GIT, '-c', 'user.email=f@example.invalid', '-c', 'user.name=f', 'commit', '-qm', 'config'], { cwd: dir });
    const configured = capture();
    expect(await main(['probe', dir, '--no-escalate'], configured.io)).toBe(0);
    const again = JSON.parse(readFileSync(join(dir, '.testguard/evidence.json'), 'utf8'));
    expect(again.run.runner).toEqual(evidence.run.runner);
  }, 60_000);
});

describe('--help says it', () => {
  it('names the flag, its values and what it needs', async () => {
    const { main } = await import('../src/cli.mjs');
    const { lines, io } = capture();
    await main(['--help'], io);
    expect(lines.out.join('\n')).toMatch(/--report-format <f>[\s\S]*jest[\s\S]*junit[\s\S]*Needs --runner-cmd/);
  });
});
