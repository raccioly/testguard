#!/usr/bin/env node
/**
 * The hand procedure behind every answer key, written down so it can be
 * repeated. It never imports or runs TestGuard: it applies a fault's exact
 * replacement to a scratch copy of the subject, runs the defenders with the
 * subject's own runner, restores the file and records what the runner said.
 *
 * It records observations, not verdicts. The verdict in expected.json is
 * written by a person reading these observations against the verdict table in
 * spec/GATE-SEMANTICS.md, and each entry says why.
 *
 * Per fault, in the order the semantics apply them:
 *   1. anchor: count occurrences of `find` in the file;
 *   2. defenders: the declared `defendedBy` files, or, when none are declared,
 *      every test file whose text names the target module (for the reader to
 *      judge imports and mocks);
 *   3. baseline: the defenders three times on unmodified source;
 *   4. typecheck (TypeScript subjects): the project's own `tsc --noEmit` with the
 *      fault applied;
 *   5. probe: the defenders three times with the fault applied;
 *   6. when every probe run passed: the whole suite three times with the fault
 *      applied (who else fails), and the defenders once with the target
 *      replaced by content that cannot parse (do they execute it at all);
 *   7. restore, and check the bytes are the original's.
 *
 * Each run is normalized to {exit, timedOut, loadError, tests: {name: outcome}}
 * where outcome is pass, skip, fail:assertion or fail:exception, read from the
 * runner's structured report. The output hash is the sha256 of the normalized
 * runs, so a later re-derivation that saw the same thing has the same hash.
 *
 * usage: node corpus/derive.mjs <subject-dir> [--only CLAIM/FAULT,...] [--out <file>]
 *                               [--python <interpreter>] [--budget <ms>] [--edits <edits.json>]
 *
 * --edits applies scripted {file, find, replace} edits to every copy first: how
 * the post-edit answers of the reuse mode are derived.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const RUNS = 3;

export function loadSubject(dir) {
  const config = JSON.parse(readFileSync(join(dir, 'subject.json'), 'utf8'));
  const claims = JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8')).claims;
  return { dir: resolve(dir), name: basename(resolve(dir)), config, claims };
}

/** Every file under dir (relative paths), skipping installed dependencies and counters. */
export function listFiles(dir, skip = (rel) => /(^|\/)(node_modules|\.venv|\.out|__pycache__)(\/|$)/.test(rel)) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip(r)) continue;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk('');
  return out.sort();
}

/**
 * A fresh copy of the subject with its dependencies reachable. A workspace's
 * node_modules holds relative links to its own packages, so it is copied with
 * the links verbatim (they then resolve inside the copy); any other
 * node_modules is linked as a whole.
 */
export function scratchCopy(subject, edits = []) {
  const dir = mkdtempSync(join(tmpdir(), `corpus-derive-${subject.name}-`));
  const counters = new Set(subject.config.counters ?? []);
  cpSync(subject.dir, dir, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = relative(subject.dir, src);
      if (rel === '') return true;
      if (counters.has(rel)) return false;
      if (/(^|\/)(\.venv|\.out|__pycache__)(\/|$)/.test(rel)) return false;
      if (subject.config.install === 'npm-workspace') return true;
      return !/(^|\/)node_modules(\/|$)/.test(rel);
    },
  });
  if (subject.config.install !== 'npm-workspace' && existsSync(join(subject.dir, 'node_modules'))) {
    symlinkSync(join(subject.dir, 'node_modules'), join(dir, 'node_modules'), 'dir');
  }
  for (const e of edits) {
    const p = join(dir, e.file);
    const text = readFileSync(p, 'utf8');
    if (text.split(e.find).length !== 2) throw new Error(`edit to ${e.file}: anchor must occur exactly once`);
    writeFileSync(p, text.replace(e.find, () => e.replace));
  }
  return dir;
}

function run(cmd, args, { cwd, budgetMs, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, budgetMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exit: code, timedOut, stdout, stderr });
    });
  });
}

const firstLine = (s) => String(s ?? '').split('\n').find((l) => l.trim() !== '') ?? '';

/** jest and vitest both write the jest-compatible JSON report. */
function parseJestShape(report, { assertionByMatcher }) {
  const tests = {};
  let loadError = null;
  for (const file of report.testResults ?? []) {
    const fileName = file.name.split('/').slice(-2).join('/');
    const assertions = file.assertionResults ?? [];
    if (assertions.length === 0 && (file.status === 'failed' || file.testExecError || file.message)) {
      loadError = firstLine(file.message || file.testExecError?.message || 'suite failed to load');
    }
    for (const a of assertions) {
      const name = `${fileName} > ${a.fullName ?? a.title}`;
      if (a.status === 'passed') tests[name] = 'pass';
      else if (a.status === 'failed') {
        const details = a.failureDetails ?? [];
        const header = firstLine(a.failureMessages?.[0]);
        const isAssertion = (assertionByMatcher && details.some((d) => d && (d.matcherResult || d.name === 'AssertionError' || d.code === 'ERR_ASSERTION')))
          || /^(AssertionError|Error: expect\()/.test(header) || /^AssertionError/.test(header);
        const isTimeout = /^Error: (Test timed out|Exceeded timeout)/.test(header);
        tests[name] = isTimeout ? 'fail:timeout' : isAssertion ? 'fail:assertion' : 'fail:exception';
      } else tests[name] = 'skip';
    }
  }
  return { tests, loadError };
}

const xmlAttr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : undefined;
};

/** JUnit XML from node --test and pytest. */
function parseJunit(xml, { kindOf }) {
  const tests = {};
  let loadError = null;
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const open = m[1];
    const body = m[3] ?? '';
    const name = `${xmlAttr(open, 'classname') ?? ''} > ${xmlAttr(open, 'name')}`;
    const failure = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/.exec(body);
    if (/<skipped/.test(body)) tests[name] = 'skip';
    else if (!failure) tests[name] = 'pass';
    else {
      const tag = failure[1] ?? failure[4];
      const attrs = failure[2] ?? failure[5] ?? '';
      const text = failure[3] ?? '';
      const kind = kindOf({ tag, message: xmlAttr(attrs, 'message') ?? '', type: xmlAttr(attrs, 'type') ?? '', text, name });
      if (kind === 'load') loadError = firstLine(xmlAttr(attrs, 'message') || text);
      else tests[name] = kind;
    }
  }
  return { tests, loadError };
}

const nodeKind = ({ message, type, text, name }) => {
  if (/\.(m|c)?js$/.test(name.split(' > ').pop() ?? '') && /testCodeFailure|ERR_/.test(type + text) && !/AssertionError/.test(text)) return 'load';
  if (/testTimeoutFailure/.test(type)) return 'fail:timeout';
  if (/AssertionError|ERR_ASSERTION/.test(text + message)) return 'fail:assertion';
  return 'fail:exception';
};

const pytestKind = ({ tag, message, text }) => {
  if (tag === 'error') return 'load';
  const last = text.trim().split('\n').pop() ?? '';
  if (/: AssertionError$/.test(last) || /^assert /.test(message) || /^AssertionError/.test(message)) return 'fail:assertion';
  return 'fail:exception';
};

/** Runs the given test files once and returns the normalized outcome plus the exact command. */
export async function runOnce(subject, cwd, files, { budgetMs, python }) {
  const out = join(mkdtempSync(join(tmpdir(), 'corpus-report-')), 'report');
  const runner = subject.config.runner;
  let cmd;
  let args;
  let parse;
  if (runner === 'vitest') {
    cmd = join(cwd, 'node_modules', '.bin', 'vitest');
    args = ['run', ...files, '--reporter=json', `--outputFile=${out}`, '--no-file-parallelism'];
    parse = (text) => parseJestShape(JSON.parse(text), { assertionByMatcher: false });
  } else if (runner === 'jest') {
    cmd = join(cwd, 'node_modules', '.bin', 'jest');
    args = [...files, '--json', `--outputFile=${out}`, '--runInBand', '--ci', '--runTestsByPath'];
    parse = (text) => parseJestShape(JSON.parse(text), { assertionByMatcher: true });
  } else if (runner === 'node-test') {
    cmd = process.execPath;
    args = ['--test', '--test-reporter=junit', `--test-reporter-destination=${out}`, ...files];
    parse = (text) => parseJunit(text, { kindOf: nodeKind });
  } else if (runner === 'pytest') {
    cmd = python;
    args = ['-m', 'pytest', ...files, '-p', 'no:cacheprovider', '-q', `--junitxml=${out}`];
    parse = (text) => parseJunit(text, { kindOf: pytestKind });
  } else throw new Error(`unknown runner ${runner}`);
  const env = runner === 'pytest' ? { PYTHONDONTWRITEBYTECODE: '1' } : {};
  const r = await run(cmd, args, { cwd, budgetMs, env });
  let parsed = { tests: {}, loadError: null };
  if (!r.timedOut) {
    try { parsed = parse(readFileSync(out, 'utf8')); } catch (e) { parsed.loadError = `no report: ${firstLine(r.stderr) || e.message}`; }
    if (r.exit !== 0 && Object.values(parsed.tests).every((t) => t === 'pass' || t === 'skip') && !parsed.loadError) {
      parsed.loadError = `runner exited ${r.exit} with no failing test: ${firstLine(r.stderr)}`;
    }
  }
  rmSync(join(out, '..'), { recursive: true, force: true });
  const command = [runner === 'pytest' ? 'python' : runner === 'node-test' ? 'node' : relative(cwd, cmd), ...args.map((a) => a.replace(out, '<report>'))].join(' ');
  return { command, run: { exit: r.exit, timedOut: r.timedOut, loadError: parsed.loadError, tests: sortKeys(parsed.tests) } };
}

const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const failing = (r) => Object.entries(r.tests).filter(([, v]) => v.startsWith('fail')).map(([k]) => k);
const green = (r) => !r.timedOut && !r.loadError && r.exit === 0 && failing(r).length === 0;

/** Test files of the whole suite (for escalation), from the subject's declared globs. */
export function suiteFiles(subject, cwd) {
  const pattern = new RegExp(subject.config.testFiles);
  return listFiles(cwd).filter((f) => pattern.test(f));
}

function countHits(text, find) {
  let n = 0;
  for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + find.length)) n++;
  return n;
}

async function deriveFault(subject, claim, fault, opts) {
  const record = { fault: `${claim.id}/${fault.id}`, file: fault.file };
  const cwd = scratchCopy(subject, opts.edits);
  try {
    const path = join(cwd, fault.file);
    const original = readFileSync(path, 'utf8');
    const hits = countHits(original, fault.find);
    record.anchor = { hits, expectHits: fault.expectHits ?? 1 };
    if (hits !== record.anchor.expectHits) return record;

    const declared = fault.defendedBy ?? claim.defendedBy;
    if (declared?.length) record.defenders = { declared, resolved: declared.filter((f) => existsSync(join(cwd, f))) };
    else {
      const stem = fault.file.replace(/\.(m|c)?(j|t)sx?$|\.py$/, '').split('/').pop();
      const candidates = suiteFiles(subject, cwd).filter((f) => readFileSync(join(cwd, f), 'utf8').includes(stem));
      record.defenders = { declared: [], candidatesNamingTarget: candidates };
      return record;
    }
    const defenders = record.defenders.resolved;
    if (defenders.length === 0) return record;

    const runs = async (files) => {
      const out = [];
      for (let i = 0; i < RUNS; i++) out.push(await runOnce(subject, cwd, files, opts));
      return out;
    };
    const baseline = await runs(defenders);
    record.commands = { defenders: baseline[0].command };
    record.baseline = baseline.map((r) => r.run);

    writeFileSync(path, original.replace(fault.find, () => fault.replace));
    try {
      if (subject.config.typecheck && /\.(m|c)?tsx?$/.test(fault.file)) {
        const tsc = await run(join(cwd, 'node_modules', '.bin', 'tsc'), ['--noEmit', '-p', 'tsconfig.json'], { cwd, budgetMs: opts.budgetMs * 2 });
        record.typecheck = { command: 'tsc --noEmit -p tsconfig.json', exit: tsc.exit, firstDiagnostic: firstLine(tsc.stdout).replace(cwd, '.') };
      }
      const probe = await runs(defenders);
      record.probe = probe.map((r) => r.run);
      if (record.probe.every(green)) {
        const suite = suiteFiles(subject, cwd);
        const whole = await runs(suite);
        record.commands.wholeSuite = whole[0].command;
        record.wholeSuite = whole.map((r) => r.run);
        const common = record.wholeSuite.map(failing).reduce((acc, f) => acc.filter((x) => f.includes(x)));
        record.wholeSuiteFailingEveryRun = common;
        writeFileSync(path, /\.py$/.test(fault.file) ? 'def (:\n' : 'export const = ;\n');
        const control = await runOnce(subject, cwd, defenders, opts);
        record.negativeControl = control.run;
      }
    } finally {
      writeFileSync(path, original);
    }
    record.restored = readFileSync(path, 'utf8') === original;
    return record;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

export function outputHash(record) {
  const observed = { anchor: record.anchor, defenders: record.defenders, baseline: record.baseline, typecheck: record.typecheck && { exit: record.typecheck.exit }, probe: record.probe, wholeSuite: record.wholeSuite, negativeControl: record.negativeControl };
  return createHash('sha256').update(JSON.stringify(observed)).digest('hex');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { only: { type: 'string' }, out: { type: 'string' }, python: { type: 'string' }, budget: { type: 'string' }, edits: { type: 'string' } } });
  const subject = loadSubject(positionals[0]);
  const only = values.only ? new Set(values.only.split(',')) : null;
  const python = values.python ?? process.env.TESTGUARD_PYTHON ?? join(subject.dir, '.venv', 'bin', 'python');
  const edits = values.edits ? JSON.parse(readFileSync(values.edits, 'utf8')) : [];
  const opts = { budgetMs: Number(values.budget ?? subject.config.budgetMs ?? 30000), python, edits };
  const records = [];
  for (const claim of subject.claims) {
    for (const fault of claim.faults) {
      const id = `${claim.id}/${fault.id}`;
      if (only && !only.has(id)) continue;
      const started = Date.now();
      const record = await deriveFault(subject, claim, fault, opts);
      record.outputHash = outputHash(record);
      record.derivedAt = new Date().toISOString();
      records.push(record);
      const p = record.probe?.map((r) => (r.timedOut ? 'T' : r.loadError ? 'L' : green(r) ? 'G' : 'R')).join('') ?? '-';
      const b = record.baseline?.map((r) => (green(r) ? 'G' : 'R')).join('') ?? '-';
      console.error(`${id}: anchor ${record.anchor.hits}/${record.anchor.expectHits} baseline ${b} probe ${p}${record.negativeControl ? ` control ${green(record.negativeControl) ? 'green' : 'red'}` : ''}${record.wholeSuiteFailingEveryRun ? ` suite-common ${record.wholeSuiteFailingEveryRun.length}` : ''} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    }
  }
  const text = `${JSON.stringify({ subject: subject.name, runs: RUNS, ...(edits.length ? { edits } : {}), records }, null, 2)}\n`;
  if (values.out) writeFileSync(values.out, text);
  else process.stdout.write(text);
}
