# Support

## Documentation

- [docs/](./docs/README.md) — the documentation hub: quickstart, installation,
  [adopting TestGuard in an existing project](./docs/guides/existing-projects.md),
  the [CLI reference](./docs/reference/cli.md) and [troubleshooting](./docs/troubleshooting.md)
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

The full list, with the one acceptable fix for each, is in
[docs/reference/verdicts.md](./docs/reference/verdicts.md); the common ones:

| You got | It usually means |
|---|---|
| `UNVERIFIABLE` | the fault's `find` string no longer matches the source (or matches more than `expectHits` times). Re-author the fault; the claim is undefended until you do. |
| `FLAKY-DEFENDER` | the declared tests are not green N/N unmodified, or disagreed with each other across probe runs. Fix the flake first. |
| `SURVIVED` with `killed-by-undeclared-tests` | some other test catches it; the claim's `defendedBy` is stale. Fix the claim. |
| `SURVIVED` after you added a test | the test passes on HEAD but does not fail on the fault. Run the fault by hand and watch the assertion. |
| `TIMEOUT` | the fault makes the code hang; that is not a detection. |

## Questions

Search [existing issues](https://github.com/raccioly/testguard/issues) and the [FAQ](./docs/faq.md) first; then ask in [Discussions](https://github.com/raccioly/testguard/discussions).

A page that is wrong or missing is a bug too: [open a documentation issue](https://github.com/raccioly/testguard/issues/new?template=documentation.md).
