# Support

## Documentation

- [README](./README.md) — what it is, the four commands, verdicts, the hook
- [spec/](./spec/) — the shared formats, and [GATE-SEMANTICS.md](./spec/GATE-SEMANTICS.md) for exactly when CI goes red
- [fixtures/known-answer/](./fixtures/known-answer/) — a worked example of every verdict
- [bench/](./bench/) — running against a real codebase
- [CONTRIBUTING.md](./CONTRIBUTING.md) — development setup

## Bugs

[Open an issue](https://github.com/raccioly/testguard/issues/new?template=bug_report.md) with:

- `testguard --version` and `node --version`
- your OS
- the command you ran and its full output
- the relevant claim from `testguard.claims.json` (redact anything private)
- what you expected instead

## Reading a verdict you did not expect

| You got | It usually means |
|---|---|
| `UNVERIFIABLE` | the fault's `find` string no longer matches the source (or matches more than `expectHits` times). Re-author the fault; the claim is undefended until you do. |
| `FLAKY-DEFENDER` | the declared tests are not green N/N unmodified, or disagreed with each other across probe runs. Fix the flake first. |
| `SURVIVED` with `killed-by-undeclared-tests` | some other test catches it; the claim's `defendedBy` is stale. Fix the claim. |
| `SURVIVED` after you added a test | the test passes on HEAD but does not fail on the fault. Run the fault by hand and watch the assertion. |
| `TIMEOUT` | the fault makes the code hang; that is not a detection. |

## Questions

Search [existing issues](https://github.com/raccioly/testguard/issues) first; then open one with the `question` label.
