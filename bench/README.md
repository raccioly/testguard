# Benchmarking against a real codebase

The fixture under `fixtures/known-answer/` proves the tool's *mechanics*. It
cannot prove the tool finds real blind spots — a fixture authored to yield an
answer necessarily yields it. That evidence has to come from a real project
with real tests and, ideally, a known result to reproduce.

Nothing about any such project belongs in this repository. The procedure
below keeps the claims file, the evidence and the expected result **outside**
it, and runs `testguard` against the project by path.

## Procedure

1. Pin the project to a commit. Verdicts are tied to a commit; a moving
   target makes a benchmark unrepeatable.
2. Write the claims file **outside both repositories**, e.g.
   `~/bench/<project>/testguard.claims.json`. Fault `file` paths are relative
   to the directory you will probe (the one whose test runner you invoke),
   not necessarily the repository root.
3. Write the expected result beside it, in the shape of
   `fixtures/known-answer/expected.json`, *before* running.
4. Run with the evidence directed outside the project, so its working tree
   is not touched:

   ```bash
   npx testguard-cli probe /path/to/project/package-dir \
     --claims ~/bench/<project>/testguard.claims.json \
     --out    ~/bench/<project>/evidence.json \
     --no-escalate
   ```

   `--no-escalate` on the first run: escalation re-runs the *whole* suite N
   times per survivor, which on a large project is minutes per finding. Turn
   it on once the declared-defender verdicts match expectations.
5. Compare `evidence.json` against the expected file. A discrepancy is a
   finding about the tool, the claims file, or the project — decide which
   before changing any of them.

## What a discrepancy usually means

| Observed | Likely cause |
|---|---|
| `unverifiable` where a verdict was expected | the anchor rotted: the project changed since the expectation was written, or the pinned commit is wrong |
| `flaky-defender` | the defenders are not green N/N unmodified — the project's flake, not the tool's; nothing about the fault can be concluded |
| `killed` where `survived` was expected | either the suite was hardened since, or the previous measurement ran once and a flake read as a detection |
| `survived` where `killed` was expected | the declared defenders are not the tests that actually catch it; escalation will say whether anything does |
