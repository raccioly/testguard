# Known-answer fixture — jest edition

The same nine claims and eleven faults as [`../known-answer`](../known-answer), in
CommonJS, run by **jest** (`jest.config.js`: `testTimeout: 1000`). Every verdict in
`expected.json` is the same. Its test suite is flaky by design (`test/flaky.test.js`).

It proves the jest runner adapter reproduces the oracle; the ESM fixture proves vitest.
