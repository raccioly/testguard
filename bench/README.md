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

## What a field report should carry

The two reports that shaped 0.1.2 and 0.1.3 were written from the human
table. Since 0.3.0 the tool also states, in machine-readable form, where a
project is and what it would tell an agent to do next. Capture both, from
the project directory, after the final probe:

```bash
testguard status --json  > ~/bench/<project>/status.json     # state, next action, changed faults, findings
testguard brief --text   > ~/bench/<project>/brief.txt       # exactly what an agent sees at session start
testguard status --json --changed <base-ref> > ~/bench/<project>/status-changed.json   # 0.5.0+: unclaimed changed files
```

and include them with the evidence. They answer the questions a report
otherwise has to argue in prose: *was anything stale when the numbers were
taken? did the tool point at the right next fix? would an agent have known
what to do?* If `status.next` disagrees with what you did next, that
disagreement is the most useful line in the report.

## Through the corpus harness

The procedure above compares one evidence file by eye. The benchmark corpus
(`corpus/README.md`) does the same comparison mechanically, under every mode
(twice, reuse, fault workers, `--changed`, partial budgets, a scratch
directory, reordered claims, metamorphic noise), and the harness takes a
project outside this repository by path. Everything about the project stays
in a directory of your own, `~/bench/<project>/` below; nothing is copied into
this repository, and the project's own working tree is never written to: the
derivation and every mode work on scratch copies (without the project's
`.git`), each committed as a fresh repository.

```
~/bench/<project>/
  subject.json               how to run it (corpus/README.md, "Layout")
  claims.json                the claims, fault paths relative to the project
  provenance/judgments.json  your verdicts, each with why
  provenance/derivation.json what the hand procedure observed
  expected.json              built from the two above
```

1. Pin the project to a commit and install its dependencies the way its
   developers do (`npm ci`, a venv). `subject.json` names the `runner`,
   `testFiles` (the whole-suite pattern), `budgetMs` and `probeArgs`; for a
   Python project also `python` (the interpreter that has its test runner);
   for an install the harness should not touch, `install: "none"`.
2. Derive what the project's own runner says, fault by fault, **without
   TestGuard**:

   ```bash
   node corpus/derive.mjs /path/to/project \
     --claims ~/bench/<project>/claims.json --config ~/bench/<project>/subject.json \
     --out ~/bench/<project>/provenance/derivation.json
   ```

   For each fault it applies the replacement to a scratch copy, runs the
   declared defenders three times unmodified and three times faulted, and, for
   a would-be survivor, runs the whole suite three times and a negative
   control. It prints one line per fault.
3. Write `provenance/judgments.json` by hand from those observations and
   `spec/GATE-SEMANTICS.md` (`{"expected": {"CLAIM/F1": {"verdict": …,
   "reason": …, "killKind": …, "why": …}}}`), then build the key:

   ```bash
   node corpus/key.mjs ~/bench/<project>
   ```

   The key is written before TestGuard first runs on the project, and never
   changed to match it. A disagreement is a finding about the tool, the
   claims or the project: decide which, and say so where you change anything.
4. Run the harness against the project:

   ```bash
   npm run corpus -- --subject-dir /path/to/project --key ~/bench/<project>/expected.json \
     --claims ~/bench/<project>/claims.json --config ~/bench/<project>/subject.json \
     --json ~/bench/<project>/scorecard.json --markdown ~/bench/<project>/scorecard.md
   ```

   Start with `--mode reference` on a large project: escalation re-runs the
   whole suite per survivor. The scorecard has the same shape as the corpus's,
   so the two can be read side by side. It names the project by `name` in
   `subject.json` (default: the directory's name), so set `name` before you
   share a scorecard.
