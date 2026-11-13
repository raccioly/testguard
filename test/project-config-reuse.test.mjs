// #301 item 1: reuse stays sound with testguard.config.json. The file feeds
// reuse only through the options it resolves to, never through its own bytes:
// a flag moved into the file with the same value carries every verdict, and a
// changed value refuses reuse exactly as the changed flag does. `--changed`
// treats the file as an input of every claim, like a lockfile.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProjectConfig, applyProjectConfig, CONFIG_FILE } from '../src/config/project-config.mjs';
import { instrumentOf, createDependencyHasher } from '../src/probe/dependencies.mjs';
import { reusableRun, carryRefusal } from '../src/probe/probe.mjs';
import { resolveProbeScope } from '../src/probe/scope.mjs';
import { commit, project } from './helpers/scope-project.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const repo = () => { const p = project(); roots.push(p.root); return p; };
const claimsOf = (dir) => JSON.parse(readFileSync(join(dir, 'testguard.claims.json'), 'utf8'));
const writeConfig = (dir, config) => writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ schemaVersion: 1, ...config }));
const defaults = { confirm: '3', budget: '120000', workers: '1', runner: 'auto' };
const fromFile = (dir, config) => { writeConfig(dir, config); return applyProjectConfig({ command: 'probe', values: defaults, loaded: readProjectConfig(dir) }).values; };

describe('moving a flag into the file', () => {
  it('gives the command exactly the options the typed flags gave it', () => {
    const p = repo();
    const typed = { ...defaults, runner: 'node-test', 'runner-cmd': 'node --test {files} --out={out}', python: join(p.dir, '.venv/bin/python'), 'node-modules': join(p.dir, 'node_modules'), typecheck: '', workers: '2', confirm: '2', budget: '9000' };
    const filed = fromFile(p.dir, { runner: 'node-test', runnerCmd: 'node --test {files} --out={out}', python: '.venv/bin/python', nodeModules: 'node_modules', typecheck: true, workers: 2, confirm: 2, budget: 9000 });
    expect(filed).toEqual(typed);
  });

  it('changes neither the instrument digest nor any fault input: the file is not a dependency', () => {
    const p = repo();
    const hashesBefore = createDependencyHasher(p.dir, { cache: false }).inputsFor(['src/price.mjs', 'test/price.test.mjs']);
    const digestBefore = instrumentOf(p.dir, '1.0.0');
    writeConfig(p.dir, { runner: 'node-test' });
    commit(p.dir);
    expect(createDependencyHasher(p.dir, { cache: false }).inputsFor(['src/price.mjs', 'test/price.test.mjs'])).toEqual(hashesBefore);
    expect(instrumentOf(p.dir, '1.0.0')).toEqual(digestBefore);
  });
});

describe('changing a value in the file', () => {
  const runner = { name: 'node-test', version: '20.0.0', source: 'builtin' };
  const instrument = { toolVersion: '1.0.0', digest: 'a'.repeat(64) };
  const previous = { tool: { version: '1.0.0' }, run: { confirmRuns: 3, workers: 1, serial: true, runner, instrument } };
  // What probe() is handed, from the values a command resolved: the run-level half of the reuse key.
  const policyOf = (values, recordedRunner = runner) => ({ confirmRuns: Number(values.confirm), workers: Number(values.workers), serial: Number(values.workers) === 1, runnerCommand: values['runner-cmd'], runner: recordedRunner, instrument });

  it('refuses reuse as the changed flag does: runnerCmd', () => {
    const p = repo();
    const same = policyOf(fromFile(p.dir, {}));
    expect(reusableRun(previous, same)).toBe(true);
    expect(carryRefusal(previous, same)).toBeUndefined();
    const filed = policyOf(fromFile(p.dir, { runnerCmd: 'node --test {files} --out={out}' }), { name: 'custom' });
    const typed = policyOf({ ...defaults, 'runner-cmd': 'node --test {files} --out={out}' }, { name: 'custom' });
    expect(filed).toEqual(typed);
    expect(reusableRun(previous, filed)).toBe(false);
    expect(carryRefusal(previous, filed)).toBeDefined();
  });

  it('hands the probe a different runner, interpreter or type check, exactly as the flag would', () => {
    const p = repo();
    const base = fromFile(p.dir, { runner: 'node-test', python: 'python3', typecheck: true });
    for (const [change, key, value] of [[{ runner: 'vitest' }, 'runner', 'vitest'], [{ python: 'python3.12' }, 'python', 'python3.12'], [{ typecheck: 'tsc --noEmit -p tsconfig.test.json' }, 'typecheck', 'tsc --noEmit -p tsconfig.test.json']]) {
      const changed = fromFile(p.dir, { runner: 'node-test', python: 'python3', typecheck: true, ...change });
      expect(changed[key]).toBe(value);
      expect(changed[key]).not.toBe(base[key]);
      expect({ ...changed, [key]: base[key] }).toEqual(base);
    }
    // The recorded runner is what the evidence compares: another engine is never reused.
    expect(reusableRun(previous, policyOf(base, { name: 'vitest', version: '5.0.5', source: 'project' }))).toBe(false);
  });
});

describe('--changed and the config file', () => {
  it('a change to the file selects every claim, naming the file as the reason', () => {
    const p = repo();
    writeConfig(p.dir, { runner: 'node-test' });
    commit(p.dir);
    const r = resolveProbeScope({ projectDir: p.dir, claims: claimsOf(p.dir), ref: p.base });
    expect(r.selected).toEqual(['PRICE-TOTAL', 'TAX-DOUBLES']);
    expect(r.matchReasons).toEqual([{ claimId: 'PRICE-TOTAL', kind: 'file', file: CONFIG_FILE }, { claimId: 'TAX-DOUBLES', kind: 'file', file: CONFIG_FILE }]);
    expect(r.unmatchedFiles).toEqual([]);
  });

  it('a deleted file selects every claim too', () => {
    const p = repo();
    writeConfig(p.dir, { runner: 'node-test' });
    const withConfig = commit(p.dir);
    rmSync(join(p.dir, CONFIG_FILE));
    commit(p.dir);
    expect(resolveProbeScope({ projectDir: p.dir, claims: claimsOf(p.dir), ref: withConfig }).selected).toEqual(['PRICE-TOTAL', 'TAX-DOUBLES']);
  });

  it('a change elsewhere still selects only what it reaches', () => {
    const p = repo();
    writeConfig(p.dir, { runner: 'node-test' });
    const withConfig = commit(p.dir);
    writeFileSync(join(p.dir, 'src/tax.mjs'), 'export const tax = (n) => n * 2 + 0;\n');
    commit(p.dir);
    expect(resolveProbeScope({ projectDir: p.dir, claims: claimsOf(p.dir), ref: withConfig }).selected).toEqual(['TAX-DOUBLES']);
  });
});
