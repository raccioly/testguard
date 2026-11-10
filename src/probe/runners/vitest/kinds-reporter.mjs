// Injected into the vitest run by TestGuard (`--reporter=<this file>`), beside
// the JSON reporter. vitest's JSON report keeps only each error's stack text,
// so it cannot say whether a failed test was an assertion or an exception.
// The runner's own error objects can: `name` and `code` survive serialization.
//
// This file is loaded inside the PROJECT's vitest, so it imports nothing.
// It writes one sidecar file (TESTGUARD_VITEST_KINDS):
//   { "version": 1, "tests": [{ "file": <abs path>, "path": [<suite names…, test name>], "kind": "assertion"|"exception" }] }
// A test is `assertion` when at least one of its errors has structured
// assertion identity, else `exception`. Anything it cannot read is left out
// and the parser treats a missing entry as `exception`.
import { writeFileSync } from 'node:fs';

const isAssertion = (e) => e != null && typeof e === 'object'
  && (e.code === 'ERR_ASSERTION' || e.name === 'AssertionError' || typeof e.operator === 'string');

const kindOf = (errors) => (errors ?? []).some(isAssertion) ? 'assertion' : 'exception';

export default class TestGuardKindsReporter {
  constructor() { this.written = false; }

  write(tests) {
    if (this.written || !process.env.TESTGUARD_VITEST_KINDS) return;
    this.written = true;
    writeFileSync(process.env.TESTGUARD_VITEST_KINDS, JSON.stringify({ version: 1, tests }));
  }

  // vitest >= 3
  onTestRunEnd(modules) {
    const tests = [];
    for (const module of modules ?? []) {
      for (const test of module.children.allTests()) {
        const result = test.result();
        if (result.state !== 'failed') continue;
        const path = [];
        for (let node = test; node && node.type !== 'module'; node = node.parent) path.unshift(node.name);
        tests.push({ file: module.moduleId, path, kind: kindOf(result.errors) });
      }
    }
    this.write(tests);
  }

  // vitest < 3: the task tree
  onFinished(files) {
    const tests = [];
    const walk = (task, path) => {
      const here = [...path, task.name];
      if (task.type === 'test' || task.type === 'custom') {
        if (task.result?.state === 'fail') tests.push({ file: task.file?.filepath ?? '', path: here, kind: kindOf(task.result.errors) });
      }
      for (const child of task.tasks ?? []) walk(child, here);
    };
    for (const file of files ?? []) for (const child of file.tasks ?? []) walk(child, []);
    this.write(tests);
  }
}
