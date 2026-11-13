// #301 item 1: testguard.config.json carries the runner options a project
// needs, so a plain `testguard probe` runs its tests correctly. These are the
// loader's rules: refused, never ignored; under every flag and variable;
// paths that stay inside the repository.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectConfig, applyProjectConfig, keyApplies, configReport, configUncommitted, projectOptions, confirmFromConfig, CONFIG_FILE, CONFIG_FLAGS } from '../src/config/project-config.mjs';
import { commit, project } from './helpers/scope-project.mjs';
import { RUNNER_NAMES } from '../src/probe/runners/index.mjs';
import { resolveFaultWorkers } from '../src/probe/fan-out.mjs';
import { serialRequested, watchConfigFile, ignoredDirtyFiles } from '../src/probe/probe.mjs';
import { PROVISIONAL_WARNING } from '../src/render.mjs';
import { serialAdvice } from '../src/status/advice.mjs';
import { UsageError, PreconditionError } from '../src/probe/precondition-error.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
const projectWith = (config) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-config-')));
  dirs.push(dir);
  if (config !== undefined) writeFileSync(join(dir, CONFIG_FILE), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
};
const refusal = (fn) => { try { fn(); } catch (error) { return error; } throw new Error('expected a refusal'); };
const defaults = { confirm: '3', budget: '120000', workers: '1', runner: 'auto' };

describe('reading testguard.config.json', () => {
  it('is absent without the file, and read with its hash when present', () => {
    expect(readProjectConfig(projectWith())).toBeUndefined();
    const loaded = readProjectConfig(projectWith({ schemaVersion: 1, runner: 'node-test' }));
    expect(loaded).toMatchObject({ file: CONFIG_FILE, config: { runner: 'node-test' } });
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an unknown key by name: a misspelled option must never fall back to the default', () => {
    const error = refusal(() => readProjectConfig(projectWith({ schemaVersion: 1, confirmRuns: 3 })));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('unknown key "confirmRuns"');
  });

  it('refuses a wrong type by the key it is on', () => {
    for (const [config, key] of [[{ schemaVersion: 1, confirm: '3' }, '"confirm"'], [{ schemaVersion: 1, workers: 0 }, '"workers"'], [{ schemaVersion: 1, typecheck: false }, '"typecheck"'], [{ schemaVersion: 1, faultWorkers: 'all' }, '"faultWorkers"'], [{ schemaVersion: 1, runner: 'mocha' }, '"runner"'], [{ schemaVersion: 1, budget: 10 }, '"budget"']]) {
      const error = refusal(() => readProjectConfig(projectWith(config)));
      expect(error).toBeInstanceOf(UsageError);
      expect(error.message).toContain(key);
    }
  });

  it('refuses malformed JSON, a missing schemaVersion and an unusable runnerCmd', () => {
    expect(refusal(() => readProjectConfig(projectWith('{ "schemaVersion": 1, ')))).toBeInstanceOf(UsageError);
    expect(refusal(() => readProjectConfig(projectWith({ runner: 'vitest' }))).message).toContain('schemaVersion');
    const error = refusal(() => readProjectConfig(projectWith({ schemaVersion: 1, runnerCmd: 'vitest run' })));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('"runnerCmd"');
  });

  it('refuses an absolute path and a path that leaves the repository; a bare python is a PATH command', () => {
    expect(refusal(() => readProjectConfig(projectWith({ schemaVersion: 1, python: '/usr/bin/python3' })))).toBeInstanceOf(UsageError);
    const error = refusal(() => readProjectConfig(projectWith({ schemaVersion: 1, nodeModules: '../elsewhere/node_modules' })));
    expect(error).toBeInstanceOf(PreconditionError);
    expect(error.kind).toBe('path-outside-project');
    expect(readProjectConfig(projectWith({ schemaVersion: 1, python: 'python3' })).resolved.python).toBe('python3');
  });

  it('judges a path by its text, never through links: a virtualenv python that links out of the tree is allowed', () => {
    const dir = projectWith({ schemaVersion: 1, python: '.venv/bin/python', nodeModules: 'node_modules' });
    mkdirSync(join(dir, '.venv', 'bin'), { recursive: true });
    symlinkSync(process.execPath, join(dir, '.venv', 'bin', 'python'));
    const loaded = readProjectConfig(dir);
    expect(loaded.resolved).toEqual({ python: join(dir, '.venv', 'bin', 'python'), nodeModules: join(dir, 'node_modules') });
  });

  it('lists exactly the runners the CLI accepts', async () => {
    const { default: schema } = await import('../spec/schemas/config.schema.json', { with: { type: 'json' } });
    expect(schema.properties.runner.enum).toEqual([...RUNNER_NAMES, 'auto']);
    expect(Object.keys(CONFIG_FLAGS)).toEqual(Object.keys(schema.properties).filter((key) => !['$schema', 'schemaVersion'].includes(key)));
  });
});

describe('the file under the command line', () => {
  const loaded = (config) => readProjectConfig(projectWith({ schemaVersion: 1, ...config }));

  it('supplies an option nobody typed, as the flag would have', () => {
    const r = applyProjectConfig({ command: 'probe', values: defaults, loaded: loaded({ runner: 'node-test', confirm: 2, budget: 5000, workers: 2, typecheck: true }) });
    expect(r.values).toMatchObject({ runner: 'node-test', confirm: '2', budget: '5000', workers: '2', typecheck: '' });
    expect(r.keys).toEqual(['runner', 'typecheck', 'workers', 'confirm', 'budget']);
    expect(r.overridden).toEqual([]);
  });

  it('a typed flag wins, judged by what was typed and never by the defaults parseArgs fills in', () => {
    const r = applyProjectConfig({ command: 'probe', values: { ...defaults, confirm: '3' }, suppliedOptions: ['confirm'], loaded: loaded({ confirm: 1, runner: 'jest' }) });
    expect(r.values.confirm).toBe('3');
    expect(r.values.runner).toBe('jest');
    expect(r.overridden).toEqual([{ key: 'confirm', by: 'flag' }]);
  });

  it('an environment variable wins over the file; an empty one is unset', () => {
    const file = loaded({ python: 'python3', nodeModules: 'vendor/node_modules', faultWorkers: 3 });
    const env = { TESTGUARD_PYTHON: 'python3.12', TESTGUARD_NODE_MODULES: '', TESTGUARD_FAULT_WORKERS: '2' };
    const r = applyProjectConfig({ command: 'probe', values: defaults, env, loaded: file });
    expect(r.values.python).toBeUndefined();
    expect(r.values['node-modules']).toBe(file.resolved.nodeModules);
    expect(r.faultWorkers).toBeUndefined();
    expect(r.overridden).toEqual([{ key: 'python', by: 'env' }, { key: 'faultWorkers', by: 'env' }]);
  });

  it('applies a key only where its flag exists', () => {
    expect(keyApplies('typecheck', 'admit')).toBe(false);
    expect(keyApplies('faultWorkers', 'sweep')).toBe(false);
    expect(keyApplies('typecheck', 'claims', { 'check-anchors': true })).toBe(true);
    expect(keyApplies('runner', 'claims', { 'check-anchors': true })).toBe(false);
    expect(keyApplies('python', 'claims', {})).toBe(false);
    const r = applyProjectConfig({ command: 'admit', values: defaults, loaded: loaded({ typecheck: 'npx tsc --noEmit', faultWorkers: 2, runner: 'vitest' }) });
    expect(r.values.typecheck).toBeUndefined();
    expect(r.keys).toEqual(['runner']);
  });

  it('reports the file by hash and the keys it supplied', () => {
    const file = loaded({ runner: 'jest', confirm: 2 });
    const r = applyProjectConfig({ command: 'probe', values: defaults, suppliedOptions: ['runner'], loaded: file });
    expect(configReport({ ...file, ...r })).toEqual({ file: CONFIG_FILE, sha256: file.sha256, keys: ['confirm'], overridden: [{ key: 'runner', by: 'flag' }] });
  });
});

describe('faultWorkers from the file', () => {
  it('comes after the flag and the variable, and is recorded as config', () => {
    expect(resolveFaultWorkers({ config: '3', cpus: 16 })).toEqual({ faultWorkers: 3, source: 'config' });
    expect(resolveFaultWorkers({ config: '3', env: { TESTGUARD_FAULT_WORKERS: '2' }, cpus: 16 })).toEqual({ faultWorkers: 2, source: 'env' });
    expect(resolveFaultWorkers({ config: '3', flag: '4', cpus: 16 })).toEqual({ faultWorkers: 4, source: 'flag' });
    expect(resolveFaultWorkers({ config: 'auto', cpus: 16 })).toMatchObject({ source: 'auto' });
    expect(resolveFaultWorkers({ config: '3', serial: true, cpus: 16 })).toEqual({ faultWorkers: 1, source: 'serial' });
  });

  it('one fault at a time from the file is a request, as it is from the flag: no fan-out stands in for it', () => {
    expect(serialRequested(1, 'config')).toBe(serialRequested(1, 'flag'));
    expect(serialRequested(1, 'config')).toBe(true);
  });
});

describe('the options a command runs with', () => {
  it('are the file under the command line, and the file it read', () => {
    const dir = projectWith({ schemaVersion: 1, runner: 'node-test', confirm: 2 });
    const r = projectOptions({ command: 'probe', projectDir: dir, values: defaults, suppliedOptions: [] });
    expect(r.values).toMatchObject({ runner: 'node-test', confirm: '2' });
    expect(r.projectConfig).toMatchObject({ file: CONFIG_FILE, keys: ['runner', 'confirm'] });
    expect(confirmFromConfig(r.projectConfig)).toBe(CONFIG_FILE);
    expect(confirmFromConfig(projectOptions({ command: 'probe', projectDir: dir, values: defaults, suppliedOptions: ['confirm'] }).projectConfig)).toBeUndefined();
  });

  it('status reports every key and changes nothing; --no-config and a plain claims listing never read the file', () => {
    const dir = projectWith({ schemaVersion: 1, runner: 'node-test' });
    const status = projectOptions({ command: 'status', projectDir: dir, values: {} });
    expect(status).toMatchObject({ values: {}, projectConfig: { keys: ['runner'] } });
    const broken = projectWith('{ not json');
    expect(projectOptions({ command: 'probe', projectDir: broken, values: { ...defaults, 'no-config': true } }).projectConfig).toBeUndefined();
    expect(projectOptions({ command: 'claims', projectDir: broken, values: {} }).projectConfig).toBeUndefined();
    expect(() => projectOptions({ command: 'claims', projectDir: broken, values: { 'check-anchors': true } })).toThrow(UsageError);
    expect(projectOptions({ command: 'gate', projectDir: broken, values: {} }).projectConfig).toBeUndefined();
  });
});

describe('the config file in the dirty rule', () => {
  it('is watched whenever it is read, present or not, by its repository path', () => {
    const watched = new Set();
    expect(watchConfigFile(watched, { root: '/repo', projectDir: '/repo/packages/api', configFile: CONFIG_FILE })).toBe(`packages/api/${CONFIG_FILE}`);
    expect([...watched]).toEqual([`packages/api/${CONFIG_FILE}`]);
    const none = new Set();
    expect(watchConfigFile(none, { root: '/repo', projectDir: '/repo', configFile: undefined })).toBeUndefined();
    expect(none.size).toBe(0);
  });

  it('when a run proceeds past it, is applied and said, never listed as ignored', () => {
    expect(ignoredDirtyFiles([CONFIG_FILE, 'test/a.test.mjs'], CONFIG_FILE)).toEqual({ configApplied: true, ignored: ['test/a.test.mjs'] });
    expect(ignoredDirtyFiles(['test/a.test.mjs'], CONFIG_FILE)).toEqual({ configApplied: false, ignored: ['test/a.test.mjs'] });
    expect(ignoredDirtyFiles([CONFIG_FILE], undefined)).toEqual({ configApplied: false, ignored: [CONFIG_FILE] });
  });
});

describe('an uncommitted file, for a command with no dirty rule', () => {
  it('is said whenever git does not hold this copy: untracked, modified, or no repository to ask', () => {
    const p = project();
    dirs.push(p.root);
    writeFileSync(join(p.dir, CONFIG_FILE), JSON.stringify({ schemaVersion: 1 }));
    expect(configUncommitted(p.dir)).toBe(true);
    commit(p.dir);
    expect(configUncommitted(p.dir)).toBe(false);
    writeFileSync(join(p.dir, CONFIG_FILE), JSON.stringify({ schemaVersion: 1, confirm: 2 }));
    expect(configUncommitted(p.dir)).toBe(true);
    expect(configUncommitted(projectWith({ schemaVersion: 1 }))).toBe(true);
  });
});

describe('speed advice for a width the file set', () => {
  it('names the file and a command that overrides it, since plain probe would read it again', () => {
    const advice = serialAdvice({ faultWorkersSource: 'config' }, 16);
    expect(advice.command).toBe('testguard probe --fault-workers auto');
    expect(advice.message).toContain('"faultWorkers": 1 in testguard.config.json');
    expect(serialAdvice({ faultWorkersSource: 'flag' }, 16).command).toBe('testguard probe');
  });
});

describe('a provisional confirm from the file', () => {
  it('is provisional exactly as the flag is, and the warning names the file', () => {
    expect(PROVISIONAL_WARNING(2)).not.toContain(CONFIG_FILE);
    expect(PROVISIONAL_WARNING(2, CONFIG_FILE)).toMatch(/^PROVISIONAL — confirmRuns 2 \(< 3, from "confirm" in testguard\.config\.json\)/);
  });
});
