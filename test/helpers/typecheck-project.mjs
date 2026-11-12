import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { probe } from '../../src/probe/probe.mjs';
import { loadClaims } from '../../src/claims/load.mjs';
import { FIXTURE_GIT } from './git.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SRC = 'export function f(x: number): number {\n  return x + 1;\n}\n';

const fault = (id, file, find, replace) => ({ id, description: id, faultClass: 'literal-changed', file, find, replace, producedBy: { producer: 'human' } });
const claim = (id, defendedBy, faults) => ({ id, statement: `${id} holds.`, severity: 'high', source: { kind: 'manual' }, producedBy: { producer: 'human' }, defendedBy, faults });
export const CLAIMS = {
  schemaVersion: 1,
  claims: [
    claim('OK', ['test/a.test.ts'], [fault('F1', 'src/a.ts', 'x + 1', 'x + 2')]),
    claim('BAD', ['test/a.test.ts'], [fault('F1', 'src/a.ts', 'return x + 1;', 'return x + 1; // BAD')]),
    claim('SLOW', ['test/a.test.ts'], [fault('F1', 'src/a.ts', 'return x + 1;', 'return x + 1; // SLOW')]),
    claim('AFTER', ['test/a.test.ts'], [fault('F1', 'src/a.ts', 'x + 1', 'x - 1')]),
    claim('JS', ['test/legacy.test.ts'], [fault('F1', 'src/legacy.js', 'n * 2', 'n * 3')]),
  ],
};

const projects = [];
export const tmpDir = () => { const d = mkdtempSync(join(tmpdir(), 'tg-typecheck-')); projects.push(d); return d; };
export const writeIn = (root, name, text) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); };

/**
 * A directory whose `typescript` is a stub `tsc` that prints what it is told
 * (a `mode` file: diagnostic, crash or slow), so the default checker path is
 * testable without a compiler. `program` is what --listFilesOnly reports.
 */
export function stubTscProject({ showConfig = '{"compilerOptions":{}}', program = ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'types/a.d.ts', 'a.js', 'a.mjs', 'a.cjs', 'a.jsx', 'src/in.ts'] } = {}) {
  const dir = tmpDir();
  writeIn(dir, 'tsconfig.json', '{}');
  writeIn(dir, 'node_modules/typescript/package.json', JSON.stringify({ name: 'typescript', version: '9.9.9', bin: { tsc: 'bin/tsc' } }));
  writeIn(dir, 'node_modules/typescript/bin/tsc', `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TG_ARGV_LOG || '/dev/null', JSON.stringify(args) + '\\n');
if (args.includes('--listFilesOnly')) { process.stdout.write(${JSON.stringify(program)}.map((f) => require('node:path').resolve(f)).concat(['/lib/lib.d.ts']).join('\\n') + '\\n'); process.exit(0); }
if (args.includes('--showConfig')) { process.stdout.write(${JSON.stringify(showConfig)}); process.exit(0); }
const mode = fs.existsSync('mode') ? fs.readFileSync('mode', 'utf8').trim() : 'clean';
if (mode === 'diagnostic') { process.stdout.write("src/a.ts(1,1): error TS2322: nope\\nsrc/b.ts(2,2): error TS2345: later\\n"); process.exit(2); }
if (mode === 'crash') { process.stderr.write('segfault, probably'); process.exit(7); }
if (mode === 'slow') setTimeout(() => {}, 60000);
else process.exit(0);
`);
  return dir;
}

export const cleanupProjects = () => { while (projects.length) rmSync(projects.pop(), { recursive: true, force: true }); };

/** Commit everything in `dir` under a pinned git config. */
export function commitAll(dir, message = 'stub') {
  const git = (...args) => { const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=f@example.invalid', '-c', 'user.name=f', ...args], { cwd: dir, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
  if (!existsSync(join(dir, '.git'))) git('init', '-q');
  git('add', '-A'); git('commit', '-q', '-m', message);
}

/**
 * A committed project whose `typescript` is a stub, so the wiring is exercised
 * in seconds. The stub's `tsc`: src/a.ts containing BAD is a type error, SLOW
 * hangs, and `x + 2` with a src/other.ts present is a program-wide error that
 * no per-fault hash can see. vitest is the real one, linked from this checkout.
 */
export function stubProject({ src = SRC } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-typecheck-probe-'));
  projects.push(dir);
  const put = (name, text) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); };
  put('.gitignore', 'node_modules/\n.testguard/\n');
  put('package.json', '{"name":"stub","private":true,"type":"module"}\n');
  put('tsconfig.json', '{}\n');
  put('src/a.ts', src);
  put('src/legacy.js', 'export function double(n) {\n  return n * 2;\n}\n');
  put('test/a.test.ts', "import { test, expect } from 'vitest';\nimport { f } from '../src/a';\ntest('f adds one', () => { expect(f(1)).toBe(2); });\n");
  put('test/legacy.test.ts', "import { test, expect } from 'vitest';\nimport { double } from '../src/legacy.js';\ntest('double doubles', () => { expect(double(4)).toBe(8); });\n");
  put('testguard.claims.json', JSON.stringify(CLAIMS, null, 2));
  put('node_modules/typescript/package.json', JSON.stringify({ name: 'typescript', version: '9.9.9', bin: { tsc: 'bin/tsc' } }));
  put('node_modules/typescript/bin/tsc', `
const fs = require('node:fs');
fs.appendFileSync(process.env.TG_TSC_LOG || '/dev/null', JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv.includes('--listFilesOnly')) { const here = process.cwd() + '/'; process.stdout.write([here + 'src/a.ts'].concat(fs.existsSync('src/other.ts') ? [here + 'src/other.ts'] : [], fs.existsSync('types/ambient.d.ts') ? [here + 'types/ambient.d.ts'] : []).join('\\n') + '\\n'); process.exit(0); }
if (process.argv.includes('--showConfig')) { process.stdout.write('{"compilerOptions":{}}'); process.exit(0); }
const source = fs.readFileSync('src/a.ts', 'utf8');
if (source.includes('SLOW')) setTimeout(() => {}, 60000);
else if (source.includes('x + 2') && fs.existsSync('src/other.ts')) { process.stdout.write('src/other.ts(1,1): error TS2305: the whole program changed\\n'); process.exit(2); }
else if (source.includes('x - 1') && fs.existsSync('types/ambient.d.ts') && fs.readFileSync('types/ambient.d.ts', 'utf8').includes('STRICT')) { process.stdout.write('types/ambient.d.ts(1,1): error TS2430: an ambient declaration nothing imports\\n'); process.exit(2); }
else if (source.includes('BAD')) { process.stdout.write('src/a.ts(2,3): error TS2322: bad replacement\\n'); process.exit(2); }
else process.exit(0);
`);
  symlinkSync(join(ROOT, 'node_modules', 'vitest'), join(dir, 'node_modules', 'vitest'), 'dir');
  commitAll(dir);
  return dir;
}

/** probe() over the project's claims; one confirm run unless `confirmRuns` says otherwise (the reuse and wiring questions do not need three). */
export const runProbe = (dir, extra = {}) => probe({ projectDir: dir, claims: loadClaims(join(dir, 'testguard.claims.json')), confirmRuns: 1, escalate: false, budgetMs: 60_000, toolVersion: 'test', ...extra });
export const byClaim = (evidence) => Object.fromEntries(evidence.records.map((r) => [r.claim.id, r]));
