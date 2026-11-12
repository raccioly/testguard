// An `error` run without the runner's own words is a defect (#291): the person
// reading `defenders-failed-to-load` had to re-run the runner by hand to learn why.
// The ledger lists every code path that can set `outcome: 'error'` and where its
// message comes from; a new path fails the scan until it is listed here.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReport as sharedParse, runProcess, mergeRuns } from '../src/probe/runners/shared.mjs';
import * as playwright from '../src/probe/runners/playwright.mjs';
import * as python from '../src/probe/runners/python.mjs';
import * as nodeTest from '../src/probe/runners/node-test.mjs';

const RUNNERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'probe', 'runners');
const ERROR_SITE = /outcome(?::\s*|\s*=\s*)'error'|\?\s*'error'\s*:/g;
const SKIP = new Set(['discovery.mjs', 'index.mjs', 'lifecycle.mjs', 'vitest.mjs', 'jest.mjs']); // no error site of their own: they call shared parseReport

const vitestReport = (files, extra = {}) => ({ numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, success: false, testResults: files, ...extra });
const playwrightReport = (errors, specs = [{ title: 'ok', line: 1, column: 1, file: 'a.spec.mjs', tests: [{ projectName: '', status: 'expected', results: [{ status: 'passed' }] }] }]) =>
  ({ suites: [{ file: 'a.spec.mjs', specs }], errors });
const nodeReport = (cases, extra = {}) => ({ schemaVersion: 1, engine: 'node-test', complete: true, version: process.versions.node, collect: false, failed: true, entries: [{ file: 'a.test.mjs', pid: 1, version: process.versions.node }], cases, ...extra });

const withProcess = async (script, parse) => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-err-'));
  try {
    writeFileSync(join(dir, 'run.mjs'), script);
    return await runProcess({ projectDir: dir, files: [], commandTemplate: [process.execPath, join(dir, 'run.mjs'), '{out}'], ...(parse ? { parse } : {}) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

/** Every path that can yield `outcome: 'error'`: where its message comes from, and a run that takes it. */
const LEDGER = [
  { file: 'shared.mjs', path: 'parseReport: a test file failed to load', source: 'the failing file\'s own message, else a fixed sentence naming the file',
    run: () => sharedParse(vitestReport([{ name: '/p/a.test.js', status: 'failed', assertionResults: [] }]), 5), expect: /a\.test\.js/ },
  { file: 'shared.mjs', path: 'parseReport: zero tests collected', source: 'a fixed sentence that says nothing ran',
    run: () => sharedParse(vitestReport([]), 5), expect: /no tests/i },
  { file: 'shared.mjs', path: 'parseReport: report of an unknown shape', source: 'a fixed sentence naming the expected shape',
    run: () => sharedParse({}, 5), expect: /testResults/ },
  { file: 'shared.mjs', path: 'runProcess: no report file written', source: 'the last stderr line, else the exit status',
    run: () => withProcess('process.exit(3)'), expect: /exited with code 3/ },
  { file: 'shared.mjs', path: 'runProcess: report unreadable', source: 'the JSON parse error',
    run: () => withProcess('import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2], "{nope")'), expect: /unreadable report/ },
  { file: 'shared.mjs', path: 'runProcess: parser returned an error with no words', source: 'the last stderr line, else the exit status',
    run: () => withProcess('import {writeFileSync} from "node:fs"; process.stderr.write("global setup exploded\\n"); writeFileSync(process.argv[2], "{}")',
      () => ({ run: { outcome: 'error', tests: { total: 0, passed: 0, failed: 0 }, assertionFailures: 0, exceptionFailures: 0, durationMs: 1 }, timeouts: 0, failedTests: [] })), expect: /global setup exploded/ },
  { file: 'shared.mjs', path: 'mergeRuns: any part errored', source: 'the first erroring part\'s message, else a fixed sentence',
    run: () => mergeRuns([
      { run: { outcome: 'pass', tests: { total: 51, passed: 51, failed: 0 }, assertionFailures: 0, exceptionFailures: 0, durationMs: 1 }, timeouts: 0, failedTests: [] },
      { run: { outcome: 'error', tests: { total: 0, passed: 0, failed: 0 }, assertionFailures: 0, exceptionFailures: 0, durationMs: 1 }, timeouts: 0, failedTests: [] },
    ]), expect: /\S/ },
  { file: 'playwright.mjs', path: 'parseReport: no tests ran', source: 'report.errors[], else a fixed sentence',
    run: () => playwright.parseReport(playwrightReport([{ message: 'Error: Timed out waiting 2000ms from config.webServer.' }], []), 5), expect: /webServer/ },
  { file: 'playwright.mjs', path: 'parseReport: tests passed but the run reported errors (global setup/teardown, webServer, reporter)', source: 'report.errors[]',
    run: () => playwright.parseReport(playwrightReport([{ message: 'Error: teardown boom' }]), 5), expect: /teardown boom/ },
  { file: 'python.mjs', path: 'parseReport: collection errors or zero tests', source: 'collectionErrors[], else a fixed sentence',
    run: () => python.parseReport({ tests: [], collectionErrors: [{ message: '' }] }, 5), expect: /\S/ },
  { file: 'python.mjs', path: 'makeRun: interpreter or engine not resolvable', source: 'the resolver\'s message', run: null },
  { file: 'node-test.mjs', path: 'parseReport: load error or no test bodies', source: 'the diagnostic, else the error message, else a fixed sentence',
    run: () => nodeTest.parseReport(nodeReport([{ file: 'a.test.mjs', name: 'x', container: false, suite: false, skipped: false, passed: false, error: { failureType: 'cancelledByParent', code: 'X', message: '', fileExit: false } }]), 5), expect: /\S/ },
];

describe('every `outcome: error` path carries a message (#291)', () => {
  it('the ledger lists every error site in src/probe/runners: a new one must be added here', () => {
    const found = {};
    for (const f of readdirSync(RUNNERS_DIR).filter((n) => n.endsWith('.mjs') && !SKIP.has(n))) {
      const n = (readFileSync(join(RUNNERS_DIR, f), 'utf8').match(ERROR_SITE) ?? []).length;
      if (n) found[f] = n;
    }
    const listed = {};
    for (const e of LEDGER) listed[e.file] = (listed[e.file] ?? 0) + 1;
    // sites per file: shared 6 (parse x2 incl. the unknown-shape path sharing one line, runProcess x2, merge x1) is asserted by the ledger length, not guessed
    expect(Object.keys(found).sort()).toEqual(Object.keys(listed).sort());
    for (const [f, n] of Object.entries(found)) expect(listed[f], `${f}: ${n} error site(s) in source, ${listed[f]} ledger entries`).toBeGreaterThanOrEqual(n);
  });

  for (const e of LEDGER.filter((x) => x.run)) {
    it(`${e.file} ${e.path} → ${e.source}`, async () => {
      const result = await e.run();
      expect(result.run.outcome).toBe('error');
      expect(typeof result.loadMessage).toBe('string');
      expect(result.loadMessage.trim()).not.toBe('');
      expect(result.loadMessage).toMatch(e.expect);
    });
  }
});
