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

[docs/reference/verdicts.md](./docs/reference/verdicts.md) has the full list,
with the one acceptable fix for each. These are the common ones:

| You got | It usually means |
|---|---|
| `UNVERIFIABLE` | The fault's `find` string no longer matches the source, or it matches more than `expectHits` times. Write the fault again. Until you do, nothing defends the claim. |
| `FLAKY-DEFENDER` | The declared tests are not green N/N on unmodified code, or they disagreed with each other across probe runs. Fix the flake first. |
| `SURVIVED` with `killed-by-undeclared-tests` | Some other test catches the fault, so the claim's `defendedBy` is stale. Fix the claim. |
| `SURVIVED` after you added a test | The test passes on HEAD but does not fail on the fault. Apply the fault by hand and watch the assertion. |
| `TIMEOUT` | The fault makes the code hang. A hang is not a detection. |

## Questions

First search [existing issues](https://github.com/raccioly/testguard/issues) and the [FAQ](./docs/faq.md). Then ask in [Discussions](https://github.com/raccioly/testguard/discussions).

A page that is wrong or missing is a bug too: [open a documentation issue](https://github.com/raccioly/testguard/issues/new?template=documentation.md).
