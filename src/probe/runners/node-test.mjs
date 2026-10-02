import { closeSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runProcess } from './shared.mjs';
import { createDiscoveryManifest, DiscoveryError, hashDiscoveryConfigs, normalizeDiscoveredFiles, runDiscoveryProcess } from './discovery.mjs';

export const name = 'node-test';
export const testGlobs = []; // Native collection is authoritative; never guess from globs.
const HERE = join(dirname(fileURLToPath(import.meta.url)), 'node');
const RUNNER = join(HERE, 'runner.mjs');
const DIRECT = join(HERE, 'direct.mjs');
const ENTRY = join(HERE, 'entry.mjs');
const VERSION = process.versions.node;
/** Admit only maintained runtime families with the in-process public API. */
export function supportsSingleProcess(version = VERSION) {
  const [major, minor] = version.split('.').map(Number);
  return major === 22 && minor >= 8 || major === 24 || major === 26;
}
const strategyHash = () => {
  const digest = createHash('sha256');
  const descriptor = openSync(process.execPath, 'r');
  try {
    const bytes = Buffer.alloc(256 * 1024);
    let length;
    while ((length = readSync(descriptor, bytes, 0, bytes.length, null)) > 0) digest.update(bytes.subarray(0, length));
  } finally { closeSync(descriptor); }
  for (const file of [fileURLToPath(import.meta.url), ...['runner.mjs', 'direct.mjs', 'entry.mjs', 'report.mjs'].map((file) => join(HERE, file)), ...['shared.mjs', 'discovery.mjs', 'lifecycle.mjs'].map((file) => join(HERE, '..', file))]) digest.update(readFileSync(file));
  return digest.digest('hex');
};
const admissionError = () => Number(VERSION.split('.')[0]) < 20 ? 'node-test requires Node20 or newer'
  : process.env.NODE_OPTIONS || process.env.NODE_PATH ? 'node-test supports default JavaScript loading; NODE_OPTIONS and NODE_PATH must be unset'
  : undefined;
export const check = async () => admissionError()
  ? { ok: false, message: admissionError() }
  : { ok: true, version: VERSION, source: 'builtin' };
export const fatalEdit = () => '/* testguard negative control: this file must not parse */\n(\n';

const receipts = () => {
  const dir = mkdtempSync(join(tmpdir(), 'testguard-node-'));
  const file = join(dir, 'entries.json');
  writeFileSync(file, '{"entries":[', { mode: 0o600 });
  return { dir, file };
};
const environment = (file, collect, workers) => ({
  TESTGUARD_NODE_ENTRIES: file,
  TESTGUARD_NODE_COLLECT: collect ? '1' : '0',
  TESTGUARD_NODE_WORKERS: String(workers),
  TESTGUARD_NODE_REPORT: '{out}',
  NODE_TEST_CONTEXT: '',
  NODE_DISABLE_COMPILE_CACHE: '1',
});
export const argvFor = (projectDir, files, { direct = false } = {}) => [process.execPath, `--import=${ENTRY}`, direct ? DIRECT : RUNNER, ...files.map((file) => resolve(realpathSync(projectDir), file))];

/** Reject unsupported/incomplete envelopes before deriving any verdict inputs. */
export function validateReport(report) {
  if (report?.schemaVersion !== 1 || report.engine !== name || report.complete !== true
    || report.version !== VERSION || typeof report.collect !== 'boolean' || typeof report.failed !== 'boolean'
    || !Array.isArray(report.entries) || report.entries.length > 100_000
    || !Array.isArray(report.cases) || report.cases.length > 100_000
    || report.diagnostic !== undefined && (typeof report.diagnostic !== 'string' || report.diagnostic.length > 65536)) throw new DiscoveryError('malformed or incomplete node-test report');
  const pids = new Set();
  for (const entry of report.entries) {
    if (!entry || typeof entry.file !== 'string' || !entry.file || entry.file.includes('\0') || !Number.isSafeInteger(entry.pid) || entry.pid <= 0 || pids.has(entry.pid) || entry.version !== report.version) throw new DiscoveryError('malformed node-test worker receipt');
    pids.add(entry.pid);
  }
  for (const t of report.cases) {
    if (!t || typeof t.file !== 'string' || typeof t.name !== 'string'
      || ['container', 'suite', 'skipped', 'passed'].some((k) => typeof t[k] !== 'boolean')
      || t.error !== undefined && (typeof t.error !== 'object' || t.error === null || typeof t.error.failureType !== 'string' || typeof t.error.code !== 'string' || typeof t.error.message !== 'string' || typeof t.error.fileExit !== 'boolean')) throw new DiscoveryError('malformed node-test result');
    if (t.passed && t.error || !t.container && (!t.file || t.file.split('/').some((part) => part === '..' || part === '') || t.file.includes('\\') || t.file.startsWith('/') || !t.name)) throw new DiscoveryError('inconsistent node-test result identity');
  }
  if (report.failed !== report.cases.some((t) => !t.passed && !t.skipped)) throw new DiscoveryError('inconsistent node-test failure summary');
  return report;
}

export function parseReport(report, durationMs) {
  validateReport(report);
  if (report.collect) throw new DiscoveryError('collection is not a test run');
  const tests = report.cases.filter((t) => !t.container && !t.suite && !t.skipped);
  const failed = tests.filter((t) => !t.passed);
  const timeout = report.cases.filter((t) => !t.skipped && t.error?.failureType === 'testTimeoutFailure');
  const loadErrors = report.cases.filter((t) => !t.skipped && !t.passed
    && (t.container || t.suite ? t.error?.failureType !== 'subtestsFailed' : !['testCodeFailure', 'testTimeoutFailure'].includes(t.error?.failureType) || t.error?.fileExit));
  if (!tests.length || !report.entries.length) loadErrors.push({ error: { message: 'node-test executed no test bodies' } });
  const assertionFailures = failed.filter((t) => t.error?.failureType === 'testCodeFailure' && !t.error.fileExit).length;
  const names = new Map();
  for (const t of tests) { const key = `${t.file}::${t.name}`; names.set(key, (names.get(key) ?? 0) + 1); }
  const seen = new Map();
  const failedTests = [];
  for (const t of tests) {
    const key = `${t.file}::${t.name}`;
    const ordinal = (seen.get(key) ?? 0) + 1; seen.set(key, ordinal);
    if (!t.passed) failedTests.push(names.get(key) > 1 ? `${key} [case ${ordinal}]` : key);
  }
  return {
    run: { outcome: loadErrors.length ? 'error' : report.failed || failed.length ? 'fail' : 'pass', tests: { total: tests.length, passed: tests.length - failed.length, failed: failed.length }, assertionFailures: loadErrors.length ? 0 : assertionFailures, durationMs },
    timeouts: timeout.length,
    loadMessage: loadErrors.length ? report.diagnostic?.split(/\r?\n/).find((line) => /(?:\bError:|SyntaxError:|cannot find|unexpected token)/i.test(line))?.trim().slice(0, 1000) ?? loadErrors[0]?.error?.message : undefined,
    failedTests,
  };
}

export async function discoverTests({ projectDir, version, timeoutMs, maxOutputBytes } = {}) {
  if (admissionError()) throw new DiscoveryError(admissionError());
  const before = hashDiscoveryConfigs(projectDir);
  const spool = receipts();
  try {
    const result = await runDiscoveryProcess({ projectDir, argv: argvFor(projectDir, []), timeoutMs, maxOutputBytes, cleanupOnClose: true, env: environment(spool.file, true, 1) });
    let report;
    try { report = validateReport(JSON.parse(result.stdout)); } catch (error) { throw new DiscoveryError(`node-test collection report: ${error.message}`); }
    if (!report.collect || report.failed) throw new DiscoveryError('node-test collection did not complete successfully');
    const files = normalizeDiscoveredFiles(projectDir, report.entries.map((entry) => entry.file));
    if (files.length !== report.entries.length) throw new DiscoveryError('node-test collection executed a duplicate entry');
    const configFiles = hashDiscoveryConfigs(projectDir);
    if (JSON.stringify(configFiles) !== JSON.stringify(before)) throw new DiscoveryError('node-test discovery config changed while modules were being collected');
    const strategy = strategyHash();
    return createDiscoveryManifest({ runner: name, version, files, configFiles, source: `native-node-entry-v1:${strategy}` });
  } finally { rmSync(spool.dir, { recursive: true, force: true }); }
}

export async function run(opts) {
  if (admissionError()) throw new DiscoveryError(admissionError());
  if (!opts.files?.length) throw new DiscoveryError('node-test requires explicit selected test files');
  const files = normalizeDiscoveredFiles(opts.projectDir, opts.files);
  const spool = receipts();
  try {
    const direct = files.length === 1 && supportsSingleProcess();
    return await runProcess({ ...opts, files, cleanupOnClose: true, env: environment(spool.file, false, opts.serial ? 1 : opts.workers ?? 1), argv: (selected) => argvFor(opts.projectDir, selected, { direct }), parse: (report, durationMs) => {
      validateReport(report);
      const entries = normalizeDiscoveredFiles(opts.projectDir, report.entries.map((entry) => entry.file));
      if (entries.length !== report.entries.length || JSON.stringify(entries) !== JSON.stringify(files)) throw new DiscoveryError('node-test did not execute every selected entry exactly');
      return parseReport(report, durationMs);
    } });
  } finally { rmSync(spool.dir, { recursive: true, force: true }); }
}
