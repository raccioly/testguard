// Injected into the Playwright run by TestGuard (`--reporter=json,<this file>`).
// Playwright's JSON report keeps only each error's text, so it cannot say
// whether a failed test was an assertion or an exception. Two structured
// signals exist in the reporter API:
//   * a failed step of category `expect`: every expect()/expect.poll()/
//     expect.soft() matcher is a step, and the step carries its own error;
//   * the error's `stack` opens with the thrown value's class name, and a
//     node:assert failure is an `AssertionError` (the name token only).
// Anything else, including a thrown string or a plain TypeError, is an
// exception. The sidecar (TESTGUARD_PLAYWRIGHT_KINDS) holds one entry per
// failed test, last attempt winning:
//   { "version": 1, "tests": [{ "file", "line", "column", "title", "project", "kind" }] }
// Loaded inside the project's Playwright, so it imports only node built-ins.
const { writeFileSync } = require('node:fs');

const className = (error) => {
  const stack = String(error?.stack ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  const m = /^([A-Za-z_$][\w$]*)(?::|\n|$)/.exec(stack);
  return m ? m[1] : undefined;
};

class TestGuardKindsReporter {
  constructor() { this.expectFailed = new Set(); this.tests = new Map(); }
  onStepEnd(test, _result, step) { if (step && step.category === 'expect' && step.error) this.expectFailed.add(test.id); }
  onTestEnd(test, result) {
    if (result.status === 'passed' || result.status === 'skipped') return;
    const assertion = this.expectFailed.has(test.id) || (result.errors ?? []).some((e) => className(e) === 'AssertionError');
    const loc = test.location ?? {};
    this.tests.set(`${test.id}`, {
      file: String(loc.file ?? '').replace(/\\/g, '/'), line: loc.line, column: loc.column, title: test.title,
      project: typeof test.parent?.project === 'function' ? (test.parent.project()?.name ?? '') : '',
      kind: assertion ? 'assertion' : 'exception',
    });
    this.expectFailed.delete(test.id);
  }
  onEnd() {
    if (!process.env.TESTGUARD_PLAYWRIGHT_KINDS) return;
    writeFileSync(process.env.TESTGUARD_PLAYWRIGHT_KINDS, JSON.stringify({ version: 1, tests: [...this.tests.values()] }));
  }
  printsToStdio() { return false; }
}
module.exports = TestGuardKindsReporter;
