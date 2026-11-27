import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The JUnit XML report reader (#329): pure conversion plus a bounded file
 * reader, no dependency.
 *
 * One format covers most stacks TestGuard has no adapter for: Maven Surefire
 * and Failsafe, Gradle, `pytest --junitxml`, `karma-junit-reporter`, the
 * Salesforce CLI's `junit` result format, `go-junit-report`, a .NET JUnit
 * logger. `--runner-cmd ... --report-format junit` reads it at `{out}`.
 *
 * The reader does not decide anything. It turns the XML into the
 * jest-compatible report `parseReport` already reads, so every rule about a
 * kill (a timeout never kills, a load failure is an error, an unreported kind
 * is an exception, an empty selection is an error) is stated once, there.
 */

/** The report formats a `--runner-cmd` may write: the jest-compatible JSON (default) or JUnit XML. */
export const REPORT_FORMATS = Object.freeze(['jest', 'junit']);

/** The most bytes of XML read in one run, over every file. A report bigger than this is not a unit-test report. */
export const MAX_JUNIT_BYTES = 64 * 1024 * 1024;
/** The most report files read from one directory. */
export const MAX_JUNIT_FILES = 10_000;

/**
 * Exception classes whose `type` says "an assertion failed", exactly and by
 * full name. Anything else, including a subclass or a lookalike, is an
 * exception: unknown rounds toward the pessimistic side (the same stance as
 * `isAssertionDetail`). `System.AssertException` is Apex's.
 */
export const ASSERTION_TYPES = Object.freeze([
  // Java: JUnit 5 and AssertJ (opentest4j), the JDK's own, JUnit 3 and 4
  'org.opentest4j.AssertionFailedError', 'java.lang.AssertionError', 'junit.framework.AssertionFailedError', 'AssertionFailedError',
  // Python
  'AssertionError',
  // Apex
  'System.AssertException',
]);
const ASSERTION_SET = new Set(ASSERTION_TYPES);

/** Timeouts never kill (GATE-SEMANTICS), so a reporter's timeout types are named too. */
export const TIMEOUT_TYPES = Object.freeze([
  'org.junit.runners.model.TestTimedOutException', 'java.util.concurrent.TimeoutException',
  'TimeoutError', 'asyncio.TimeoutError', 'asyncio.exceptions.TimeoutError',
]);
const TIMEOUT_SET = new Set(TIMEOUT_TYPES);

export const isAssertionType = (type) => typeof type === 'string' && ASSERTION_SET.has(type);

/**
 * The exception class at the head of a message, when it is the whole of the
 * first line up to a colon (`System.AssertException: Expected: 1`). Used only
 * when the reporter left `type` out: a message that merely mentions a class
 * does not count.
 */
const HEAD_CLASS = /^([A-Za-z_][\w$.]*)\s*(?::|$)/;
const headClass = (value) => HEAD_CLASS.exec(firstLine(value))?.[1];
const firstLine = (value) => String(value ?? '').trimStart().split('\n')[0].trimEnd();

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => (s.includes('&')
  ? s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|amp|quot|apos));/g, (whole, dec, hex, name) => {
    if (name) return ENTITIES[name];
    const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  })
  : s);

// One pass over the text. Comments, CDATA, processing instructions and a
// doctype are matched first so that a `<testcase>` inside one of them is never
// read as an element. A `<` that matches nothing stays text.
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!(?!\[CDATA\[|--)[^>]*>|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
// Only these keep their text, and only its start: the first line is all that is read.
const KEEPS_TEXT = new Set(['failure', 'error', 'skipped']);
const TEXT_CAP = 4096;

/**
 * A tolerant scanner, not a validating parser. Returns `{ root, truncated }`:
 * `root` is a synthetic node whose children are the top-level elements, each
 * `{ name, attrs, children, text }`. `truncated` is true when an element was
 * still open at the end of the input. Iterative: a deeply nested document
 * cannot overflow the stack.
 */
export function scanXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let last = 0;
  const addText = (value, raw) => {
    const top = stack[stack.length - 1];
    if (KEEPS_TEXT.has(top.name) && top.text.length < TEXT_CAP) top.text += raw ? value : decode(value);
  };
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(xml)) !== null) {
    if (m.index > last) addText(xml.slice(last, m.index), false);
    last = TOKEN.lastIndex;
    if (m[1] !== undefined) { addText(m[1], true); continue; }
    if (m[2] !== undefined) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === m[2]) { stack.length = i; break; }
      continue;
    }
    if (m[3] === undefined) continue;
    const attrs = {};
    for (const a of m[4].matchAll(ATTRIBUTE)) attrs[a[1]] = decode(a[2] ?? a[3]);
    const node = { name: m[3], attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (m[5] !== '/') stack.push(node);
  }
  if (last < xml.length) addText(xml.slice(last), false);
  return { root, truncated: stack.length > 1 };
}

const count = (value) => { const n = Number.parseInt(value ?? '', 10); return Number.isFinite(n) && n > 0 ? n : 0; };
const elements = (node, name) => node.children.filter((c) => c.name === name);

/** Every testsuite element, outermost first, found without recursion. */
function suitesIn(root) {
  const found = [];
  const todo = [root];
  while (todo.length) {
    const node = todo.pop();
    if (node.name === 'testsuite') found.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) todo.push(node.children[i]);
  }
  return found;
}

/**
 * Is a failure an assertion? The structured `type` decides whenever the
 * reporter gave one: a type that is not in the list is an exception even if
 * the message looks like an assertion. Only when `type` is absent is the
 * exception class at the head of the message (or of the stack trace the
 * element carries) read, and only as a whole name from the same list.
 */
function failureIsAssertion(failure) {
  const type = failure.attrs.type;
  if (type !== undefined && type !== '') return isAssertionType(type);
  return isAssertionType(headClass(failure.attrs.message)) || isAssertionType(headClass(failure.text));
}

function testResultOf(suite, suiteName) {
  const cases = elements(suite, 'testcase');
  const assertionResults = cases.map((tc) => {
    const failure = tc.children.find((c) => c.name === 'failure' || c.name === 'error');
    const title = tc.attrs.name ?? '';
    const owner = tc.attrs.classname || suiteName;
    const base = { title, fullName: `${owner} ${title}`.trim(), ancestorTitles: [owner] };
    if (!failure) return { ...base, status: tc.children.some((c) => c.name === 'skipped') ? 'pending' : 'passed', failureMessages: [] };
    const type = failure.attrs.type ?? '';
    const message = failure.attrs.message ?? firstLine(failure.text);
    const assertion = failureIsAssertion(failure);
    return {
      ...base,
      status: 'failed',
      failureMessages: [`${type ? `${type}: ` : ''}${message}`.trim()],
      failureDetails: [assertion ? { name: 'AssertionError' } : { name: type || 'Error' }],
      ...(TIMEOUT_SET.has(type) ? { failureType: 'testTimeoutFailure' } : {}),
    };
  });
  const failedCase = assertionResults.some((t) => t.status === 'failed');
  // A suite that reports errors or failures and ran no testcase never got to
  // run its tests (a class that would not load, a fixture that threw).
  const loadFailure = cases.length === 0 && count(suite.attrs.errors) + count(suite.attrs.failures) > 0;
  if (loadFailure) {
    const why = suite.children.find((c) => c.name === 'error' || c.name === 'failure');
    const message = why ? (why.attrs.message ?? firstLine(why.text)) : '';
    return { name: suiteName, status: 'failed', assertionResults, message: message || `the test suite ${suiteName} reported an error and ran no test` };
  }
  return { name: suiteName, status: failedCase ? 'failed' : 'passed', message: '', assertionResults };
}

/**
 * The jest-compatible report for a set of JUnit XML documents (their text).
 * Throws when a document is truncated, or when none holds a `<testsuite>`:
 * what cannot be read is never read as passing. A document with no testsuite
 * is skipped when another one has some (a build file next to the reports).
 */
export function junitToReport(documents) {
  const testResults = [];
  let unnamed = 0;
  for (const xml of documents) {
    const { root, truncated } = scanXml(xml);
    if (truncated) throw new Error('a JUnit XML report is truncated (an element was never closed); the run is not read as passing');
    for (const suite of suitesIn(root)) {
      // An outer suite that only groups others has no test of its own: the inner ones carry them.
      if (elements(suite, 'testsuite').length > 0 && elements(suite, 'testcase').length === 0) continue;
      testResults.push(testResultOf(suite, suite.attrs.name || `testsuite-${++unnamed}`));
    }
  }
  if (testResults.length === 0) throw new Error('not a JUnit XML report: no <testsuite> element');
  const all = testResults.flatMap((f) => f.assertionResults);
  const failed = all.filter((t) => t.status === 'failed').length;
  const loadFailed = testResults.some((f) => f.status === 'failed' && f.assertionResults.length === 0);
  return {
    numTotalTests: all.length,
    numPassedTests: all.filter((t) => t.status === 'passed').length,
    numFailedTests: failed,
    numPendingTests: all.filter((t) => t.status === 'pending').length,
    success: failed === 0 && !loadFailed && all.length > 0,
    testResults,
  };
}

function readBounded(path, budget) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size > budget.left) throw new Error(`the JUnit XML reports exceed ${budget.max} bytes; a unit-test report is far smaller, so the run is not read`);
    const buffer = Buffer.alloc(size);
    let at = 0;
    while (at < size) {
      const n = readSync(fd, buffer, at, size - at, at);
      if (n === 0) break;
      at += n;
    }
    budget.left -= size;
    return buffer.toString('utf8', 0, at).replace(/^﻿/, '');
  } finally { closeSync(fd); }
}

/**
 * Read the report at `path`: one XML file, or a directory of them
 * (`TEST-*.xml` and any other `*.xml`, one level, sorted by name; a link or a
 * file that is not `.xml` is ignored). Bounded in bytes and in files.
 */
export function readJunitReport(path, { maxBytes = MAX_JUNIT_BYTES, maxFiles = MAX_JUNIT_FILES } = {}) {
  const budget = { left: maxBytes, max: maxBytes };
  const stat = lstatSync(path);
  let files;
  if (stat.isDirectory()) {
    files = readdirSync(path, { withFileTypes: true }).filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.xml')).map((e) => e.name).sort();
    if (files.length === 0) throw new Error('the directory at {out} holds no .xml report');
    if (files.length > maxFiles) throw new Error(`the directory at {out} holds more than ${maxFiles} .xml files`);
    files = files.map((name) => join(path, name));
  } else if (stat.isFile()) files = [path];
  else throw new Error('{out} is neither a file nor a directory');
  return junitToReport(files.map((file) => readBounded(file, budget)));
}
