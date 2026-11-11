# known-answer-typescript

A small TypeScript project for the type check (`probe --typecheck`). Seven faults, hand verified (see
`expected.json`): two type-check and are probed normally (one kill, one survivor), two parse but do not
type-check (`fault-invalid` / `replacement-does-not-typecheck`, one of them only in a *caller* of the
faulted file), one type-checks after the invalid ones (no leaked diagnostics), and two are files outside the program, one JavaScript and one TypeScript the
tsconfig does not include (`detail.typecheck: "not-applicable"`: tsc never reads them).

`typescript` and `vitest` are dependencies of this fixture only: `npm ci` in this directory. The tool's own
runtime dependencies are untouched.
