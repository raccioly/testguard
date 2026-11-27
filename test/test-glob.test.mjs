// #332: `--test-glob <glob>` (repeatable) and `"testGlobs"` in testguard.config.json
// name the tests of a suite no built-in glob knows, so escalation under a
// `--runner-cmd` can ask them. These are the rules: what a glob may be, what it
// matches, how it joins the universe, and that it is part of the universe hash.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkTestGlob, normalizeTestGlobs, matchTestGlobs } from '../src/probe/test-globs.mjs';
import { commandUniverse, probe } from '../src/probe/probe.mjs';
import { hashCustomCommandUniverse } from '../src/probe/universe.mjs';
import { parseCommandTemplate } from '../src/probe/runners/shared.mjs';
import { runnerOptions } from '../src/commands/runner-options.mjs';
import { readProjectConfig, applyProjectConfig, CONFIG_FILE } from '../src/config/project-config.mjs';
import { withScratchBase } from '../src/scratch-dir.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { UsageError } from '../src/probe/precondition-error.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';
import { main } from '../src/cli.mjs';
import { replay } from '../src/replay/replay.mjs';

const dirs = [];
const tmp = (prefix) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(dir); return dir; };
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const put = (dir, rel, text = 'x\n') => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };

describe('what a test glob may be', () => {
  it('accepts a relative glob and names the problem with any other', () => {
    for (const glob of ['src/test/**/*Test.java', 'test/*Test.cls', 'a.test']) expect(checkTestGlob(glob), glob).toBeUndefined();
    expect(checkTestGlob('')).toMatch(/empty/);
    expect(checkTestGlob('   ')).toMatch(/empty/);
    expect(checkTestGlob('/abs/**/*Test.java')).toMatch(/relative/);
    expect(checkTestGlob('C:\\proj\\*Test.java')).toMatch(/relative/);
    expect(checkTestGlob('..\\x')).toMatch(/relative/);
    expect(checkTestGlob('../other/*Test.java')).toMatch(/inside the project/);
    expect(checkTestGlob('src/../../x/*.java')).toMatch(/inside the project/);
    expect(checkTestGlob(42)).toMatch(/string/);
  });

  it('normalizes to a sorted list without duplicates, so the order typed never changes the hash', () => {
    expect(normalizeTestGlobs(['b/*.java', 'a/*.java', 'b/*.java'])).toEqual(['a/*.java', 'b/*.java']);
    expect(normalizeTestGlobs(undefined)).toEqual([]);
  });
});

describe('what a test glob matches', () => {
  it('finds the files, skips node_modules and the scratch directory, and never leaves the project', () => {
    const project = tmp('tg-glob-');
    put(project, 'src/test/FooTest.java');
    put(project, 'src/test/deep/BarTest.java');
    put(project, 'src/main/Foo.java');
    put(project, 'node_modules/pkg/ZedTest.java');
    put(project, '.scratch/testguard-wt-1/src/test/GhostTest.java');
    expect(matchTestGlobs(project, ['src/test/**/*Test.java'], { scratchDir: join(project, '.scratch') }))
      .toEqual(['src/test/FooTest.java', 'src/test/deep/BarTest.java']);
    expect(matchTestGlobs(project, ['**/*Test.java'], { scratchDir: join(project, '.scratch') }))
      .toEqual(['src/test/FooTest.java', 'src/test/deep/BarTest.java']);
    expect(matchTestGlobs(project, [])).toEqual([]);
    expect(matchTestGlobs(project, ['nothing/*.java'])).toEqual([]);
  });

  it('skips the configured scratch root of the run when none is passed', () => {
    const project = tmp('tg-glob-');
    put(project, 'src/test/FooTest.java');
    put(project, 'scratch/GhostTest.java');
    withScratchBase(join(project, 'scratch'), () => {
      expect(matchTestGlobs(project, ['**/*Test.java'])).toEqual(['src/test/FooTest.java']);
    });
  });
});

describe('the universe', () => {
  it('holds the matched files beside the adapter globs and the declared defenders, once each and sorted', () => {
    expect(commandUniverse(['test/a.test.mjs'], ['test/DeclaredTest.java'], ['test/ExtraTest.java', 'test/DeclaredTest.java']))
      .toEqual(['test/DeclaredTest.java', 'test/ExtraTest.java', 'test/a.test.mjs']);
    expect(commandUniverse([], ['test/DeclaredTest.java'])).toEqual(['test/DeclaredTest.java']);
  });

  it('binds the globs into the universe hash, and leaves the hash of a run without them as it was', () => {
    const words = parseCommandTemplate('glue.sh {out} {files}');
    const files = ['test/GuardTest.java'];
    const plain = hashCustomCommandUniverse(files, words, 'vitest');
    expect(hashCustomCommandUniverse(files, words, 'vitest', [])).toBe(plain);
    const a = hashCustomCommandUniverse(files, words, 'vitest', ['test/*Test.java']);
    expect(a).not.toBe(plain);
    expect(hashCustomCommandUniverse(files, words, 'vitest', ['test/*Test.java', 'other/*Test.java'])).not.toBe(a);
    // The order typed is not a change.
    expect(hashCustomCommandUniverse(files, words, 'vitest', ['b/*', 'a/*'])).toBe(hashCustomCommandUniverse(files, words, 'vitest', ['a/*', 'b/*']));
  });
});

describe('the command line and the config file share one validation', () => {
  it('runnerOptions returns the globs, and refuses them without a --runner-cmd or when one is unusable', () => {
    const cmd = 'glue.sh {out} {files}';
    expect(runnerOptions({ 'runner-cmd': cmd, 'test-glob': ['a/*Test.java', 'b/*Test.java'] })).toMatchObject({ runnerCommand: cmd, testGlobs: ['a/*Test.java', 'b/*Test.java'] });
    expect(runnerOptions({ 'runner-cmd': cmd }).testGlobs ?? []).toEqual([]);
    expect(runnerOptions({ 'test-glob': ['a/*Test.java'] }).error).toMatch(/--test-glob needs --runner-cmd/);
    expect(runnerOptions({ 'runner-cmd': cmd, 'test-glob': [''] }).error).toMatch(/--test-glob.*empty/);
    expect(runnerOptions({ 'runner-cmd': cmd, 'test-glob': ['../x/*'] }).error).toMatch(/--test-glob.*inside the project/);
  });

  const withConfig = (config) => {
    const dir = tmp('tg-config-');
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ schemaVersion: 1, ...config }));
    return dir;
  };
  const refusal = (fn) => { try { fn(); } catch (error) { return error; } throw new Error('expected a refusal'); };

  it('reads "testGlobs" as a list of relative globs, and refuses anything else by key', () => {
    const loaded = readProjectConfig(withConfig({ runnerCmd: 'glue.sh {out} {files}', testGlobs: ['src/test/**/*Test.java'] }));
    expect(loaded.config.testGlobs).toEqual(['src/test/**/*Test.java']);
    for (const bad of ['src/test/*.java', [], [''], [3], ['/abs/*Test.java'], ['../x/*Test.java'], ['a', 'a']]) {
      const error = refusal(() => readProjectConfig(withConfig({ runnerCmd: 'glue.sh {out} {files}', testGlobs: bad })));
      expect(error, JSON.stringify(bad)).toBeInstanceOf(UsageError);
      expect(error.message, JSON.stringify(bad)).toContain('"testGlobs"');
    }
  });

  it('applies the list as the repeated flag would, and a typed flag replaces it whole', () => {
    const loaded = readProjectConfig(withConfig({ runnerCmd: 'glue.sh {out} {files}', testGlobs: ['a/*Test.java', 'b/*Test.java'] }));
    const defaults = { confirm: '3', budget: '120000', workers: '1', runner: 'auto' };
    const applied = applyProjectConfig({ command: 'probe', values: defaults, loaded });
    expect(applied.values['test-glob']).toEqual(['a/*Test.java', 'b/*Test.java']);
    expect(applied.keys).toEqual(['runnerCmd', 'testGlobs']);
    const typed = applyProjectConfig({ command: 'probe', values: { ...defaults, 'test-glob': ['c/*Test.java'] }, suppliedOptions: ['test-glob'], loaded });
    expect(typed.values['test-glob']).toEqual(['c/*Test.java']);
    expect(typed.overridden).toEqual([{ key: 'testGlobs', by: 'flag' }]);
    for (const command of ['admit', 'sweep', 'replay']) expect(applyProjectConfig({ command, values: defaults, loaded }).values['test-glob'], command).toEqual(['a/*Test.java', 'b/*Test.java']);
  });

  it('the schema and the validator accept the key', () => {
    expect(validate('config', { schemaVersion: 1, runnerCmd: 'glue.sh {out} {files}', testGlobs: ['src/test/**/*Test.java'] }).errors).toEqual([]);
    expect(validate('config', { schemaVersion: 1, testGlobs: [] }).ok).toBe(false);
  });
});

// A suite no JavaScript runner lists: the report comes from a small script
// (as in runner-cmd-identity.test.mjs). ExtraTest.java is declared by no claim.
const REPORTER = `const fs=require('node:fs');const out=process.argv.at(-1);const files=process.argv.slice(2,-1);
const src=fs.readFileSync('src/Guard.java','utf8');
const results=files.map((f)=>{const ok=f.endsWith('GuardTest.java')?!src.includes('testguard negative control'):src.includes('value = 1');
return {name:f,assertionResults:[{status:ok?'passed':'failed',fullName:'t',failureMessages:ok?[]:['AssertionError: expected one']}]};});
const failed=results.filter((r)=>r.assertionResults[0].status==='failed').length;
fs.writeFileSync(out,JSON.stringify({success:!failed,numTotalTests:results.length,numPassedTests:results.length-failed,numFailedTests:failed,testResults:results}));`;
const by = { producer: 'human', by: 'fixture' };
const claim = { id: 'GUARD', statement: 'The GUARD value is one.', source: { kind: 'spec', ref: 'fixture' }, severity: 'high', producedBy: by, defendedBy: ['test/GuardTest.java'],
  faults: [{ id: 'F1', description: 'Change the value.', faultClass: 'literal-changed', file: 'src/Guard.java', find: 'value = 1', replace: 'value = 2', producedBy: by }] };
const fixture = () => {
  const dir = tmp('tg-test-glob-');
  put(dir, 'src/Guard.java', 'class Guard { int value = 1; }\n');
  put(dir, 'test/GuardTest.java', 'class T {}\n');
  put(dir, 'test/ExtraTest.java', 'class T {}\n');
  put(dir, 'runner.cjs', REPORTER);
  put(dir, 'testguard.claims.json', JSON.stringify({ schemaVersion: 1, claims: [claim] }, null, 2));
  put(dir, '.gitignore', '.testguard/\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']]) {
    execFileSync('git', [...FIXTURE_GIT, ...args], { cwd: dir, timeout: 5000 });
  }
  return dir;
};
const runProbe = (dir, testGlobs) => probe({
  projectDir: dir, claims: loadClaims(join(dir, 'testguard.claims.json')), confirmRuns: 1, budgetMs: 10_000,
  runnerCommand: `${JSON.stringify(process.execPath)} runner.cjs {files} {out}`, testGlobs,
});

describe('a --runner-cmd probe with --test-glob', () => {
  it('escalates to a test no claim declares, and re-measures what the universe did not hold', async () => {
    const dir = fixture();
    const without = await runProbe(dir);
    expect(without.records[0].verdict).toBe('survived');
    expect(without.records[0].detail.escalationSkipped).toBe('no-test-outside-defenders');

    const withGlob = await runProbe(dir, ['test/*Test.java']);
    const record = withGlob.records[0];
    expect(record.verdict).toBe('survived');
    expect(record.detail.escalated).toBe(true);
    expect(record.detail.reason).toBe('killed-by-undeclared-tests');
    expect(record.detail.undeclaredKillers).toEqual(['test/ExtraTest.java::t']);
    expect(record.detail).not.toHaveProperty('escalationSkipped');
    expect(record.inputs.testUniverseHash).not.toBe(without.records[0].inputs.testUniverseHash);
    expect(validate('evidence', withGlob).errors).toEqual([]);
  }, 30_000);

  it('a glob that matches nothing leaves the skip honest', async () => {
    const dir = fixture();
    const evidence = await runProbe(dir, ['nowhere/*Test.java']);
    expect(evidence.records[0].detail.escalationSkipped).toBe('no-test-outside-defenders');
  }, 30_000);
});

describe('the command line', () => {
  const run = async (args) => {
    const err = [];
    const code = await main(args, { out: () => {}, err: (s) => err.push(s) });
    return { code, err: err.join('\n') };
  };

  it('refuses --test-glob without --runner-cmd, for every command that runs tests, before anything runs', async () => {
    const dir = fixture();
    for (const args of [['probe', dir], ['sweep', dir, '--changed', 'HEAD'], ['replay', dir, '--since', 'HEAD~1..HEAD'], ['admit', dir, '--claim', 'GUARD']]) {
      const { code, err } = await run([...args, '--test-glob', 'test/*Test.java']);
      expect(code, args[0]).toBe(3);
      expect(err, args[0]).toMatch(/--test-glob needs --runner-cmd/);
    }
  }, 30_000);

  it('names the glob it refuses', async () => {
    const dir = fixture();
    const { code, err } = await run(['probe', dir, '--runner-cmd', 'glue.sh {out} {files}', '--test-glob', '../elsewhere/*Test.java']);
    expect(code).toBe(3);
    expect(err).toMatch(/--test-glob "\.\.\/elsewhere\/\*Test\.java" must stay inside the project/);
  }, 30_000);

  it('applies "testGlobs" from the config file only beside a command, and --no-config ignores it', async () => {
    const dir = fixture();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ schemaVersion: 1, testGlobs: ['test/*Test.java'] }));
    const refused = await run(['probe', dir, '--include-dirty']);
    expect(refused.code).toBe(3);
    expect(refused.err).toMatch(/--test-glob needs --runner-cmd/);
    const ignored = await run(['probe', dir, '--no-config', '--include-dirty', '--allow-empty', '--claim', 'NOPE']);
    expect(ignored.err).not.toMatch(/--test-glob needs/);
  }, 30_000);
});

describe('replay with --test-glob', () => {
  // The fix ships src/value.mjs and test/value.test.mjs; before it, check/value.check.mjs
  // (a name the built-in globs do not list) already imported the buggy source.
  const history = () => {
    const dir = tmp('tg-replay-glob-');
    const g = (...args) => execFileSync('git', [...FIXTURE_GIT, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', ...args], { cwd: dir, timeout: 5000, encoding: 'utf8' });
    put(dir, 'src/value.mjs', 'export const value = 0;\n');
    put(dir, 'check/value.check.mjs', "import { value } from '../src/value.mjs';\n");
    put(dir, 'runner.cjs', `const fs=require('node:fs');const out=process.argv.at(-1);const files=process.argv.slice(2,-1);
const bad=fs.readFileSync('src/value.mjs','utf8').includes('value = 0');
const results=files.map((f)=>({name:f,assertionResults:[{status:bad?'failed':'passed',fullName:'t',failureMessages:bad?['AssertionError: expected one']:[]}]}));
fs.writeFileSync(out,JSON.stringify({success:!bad,numTotalTests:results.length,numPassedTests:bad?0:results.length,numFailedTests:bad?results.length:0,testResults:results}));`);
    g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'base');
    put(dir, 'src/value.mjs', 'export const value = 1;\n');
    put(dir, 'test/value.test.mjs', "import { value } from '../src/value.mjs';\n");
    g('add', '-A'); g('commit', '-qm', 'fix: value is one');
    return dir;
  };
  const run = (dir, testGlobs) => replay({ projectDir: dir, range: 'HEAD~1..HEAD', confirmRuns: 1, budgetMs: 10_000, toolVersion: 'test', testGlobs,
    runnerCommand: `${JSON.stringify(process.execPath)} runner.cjs {files} {out}` });

  it('has no test to ask without the glob, and asks the tests the glob names with it', async () => {
    const dir = history();
    const without = await run(dir);
    expect(without.records[0]).toMatchObject({ verdict: 'unverifiable', reason: 'the-fix-shipped-the-only-test-file' });
    const withGlob = await run(dir, ['check/*.check.mjs']);
    expect(withGlob.records[0].ranTests).toBe(1);
    expect(withGlob.records[0].verdict).toBe('caught');
    expect(validate('replay', withGlob).errors).toEqual([]);
  }, 30_000);
});
