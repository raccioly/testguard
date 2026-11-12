#!/usr/bin/env node
/**
 * How fast is the default on a project of cheap unit tests? (issue #270)
 *
 * Generates a vitest project of `--modules` small modules, each with its own
 * test file and one claim of three faults, then times four probes through the
 * CLI: from scratch serially (`--serial`, the pre-0.23 behavior), from scratch
 * with the default, a no-change rerun with the default (verdict reuse), and
 * `--changed` after touching one module. Prints a markdown table with the
 * guard's share of the fan-out separated.
 *
 *   node bench/cheap-units.mjs [--modules 24]
 *
 * Uses this checkout's node_modules for vitest; makes no network call.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'cli', 'testguard.mjs');
const { values } = parseArgs({ options: { modules: { type: 'string', default: '24' } } });
const n = Number(values.modules);

const dir = mkdtempSync(join(tmpdir(), 'tg-cheap-units-'));
const git = (...args) => {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
};
mkdirSync(join(dir, 'src'));
mkdirSync(join(dir, 'test'));
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'cheap-units', private: true, type: 'module' }));
writeFileSync(join(dir, '.gitignore'), 'node_modules\n.testguard/\n');
symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
const claims = { schemaVersion: 1, claims: [] };
for (let i = 0; i < n; i++) {
  writeFileSync(join(dir, `src/m${i}.mjs`), `export function price${i}(qty, unit) {\n  if (qty < 0) throw new RangeError('negative');\n  const total = qty * unit;\n  return total > 100 ? total - 5 : total;\n}\n`);
  writeFileSync(join(dir, `test/m${i}.test.mjs`), `import { expect, test } from 'vitest';\nimport { price${i} } from '../src/m${i}.mjs';\ntest('prices', () => {\n  expect(price${i}(2, 3)).toBe(6);\n  expect(price${i}(30, 4)).toBe(115);\n  expect(() => price${i}(-1, 1)).toThrow(RangeError);\n});\n`);
  const fault = (id, find, replace, faultClass) => ({ id, description: id, faultClass, file: `src/m${i}.mjs`, find, replace, producedBy: { producer: 'human' } });
  claims.claims.push({
    id: `PRICE-${i}`, statement: `price${i} totals, discounts over 100, and refuses a negative quantity.`, source: { kind: 'manual', ref: 'bench' }, severity: 'high', producedBy: { producer: 'human' }, defendedBy: [`test/m${i}.test.mjs`],
    faults: [
      fault('F1', '  if (qty < 0) throw new RangeError', '  if (false) throw new RangeError', 'guard-removed'),
      fault('F2', 'total - 5', 'total', 'return-altered'),
      fault('F3', 'qty * unit', 'qty + unit', 'variable-swap'),
    ],
  });
}
writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(claims, null, 2));
git('init', '-q');
git('add', '-A');
git('commit', '-qm', 'cheap units');

const run = (label, args) => {
  const started = performance.now();
  const r = spawnSync(process.execPath, [CLI, 'probe', '.', '--no-escalate', '--quiet', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, TESTGUARD_FAULT_WORKERS: '' } });
  const ms = performance.now() - started;
  if (r.status !== 0) throw new Error(`${label}: exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : args.includes('--changed') ? '.testguard/evidence-partial.json' : '.testguard/evidence.json';
  const evidence = JSON.parse(readFileSync(join(dir, out), 'utf8'));
  const m = evidence.run.measurements;
  return { label, ms, faults: evidence.records.length, reused: evidence.run.reuse?.reused ?? 0, invocations: m.runnerInvocations, width: evidence.run.faultWorkers ?? 1, guardMs: (m.aloneConfirmMs ?? 0) + (m.remeasureMs ?? 0), confirms: m.aloneConfirmRuns ?? 0 };
};

const load = loadavg()[0].toFixed(1);
const rows = [];
try {
  rows.push(run('from scratch, --serial (0.22 behavior)', ['--serial', '--out', '.testguard/serial.json', '--no-reuse']));
  rows.push(run('from scratch, default', ['--no-reuse']));
  rows.push(run('no-change rerun, default', []));
  writeFileSync(join(dir, 'src/m0.mjs'), readFileSync(join(dir, 'src/m0.mjs'), 'utf8').replace('total - 5', 'total - 5 // touched'));
  git('commit', '-qam', 'touch m0');
  rows.push(run('--changed HEAD~1 after touching one module', ['--changed', 'HEAD~1']));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`${n} modules, ${n * 3} faults; ${availableParallelism()} CPUs, load average ${load} at start\n`);
console.log('| run | wall | faults measured / reused | fault workers | runner invocations | guard: confirmations (time) |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.label} | ${(r.ms / 1000).toFixed(1)} s | ${r.faults - r.reused} / ${r.reused} | ${r.width} | ${r.invocations} | ${r.confirms} (${(r.guardMs / 1000).toFixed(1)} s) |`);
