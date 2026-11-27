# Frequently asked questions

Short answers to the questions people ask before and during adoption. Each
answer links to the page that explains it in full.

## The idea

### Is this just mutation testing?

The mechanism is the same: break the code on purpose and see whether a test
fails. That idea dates to the 1970s. Stryker, PIT, mutmut and Cosmic Ray all
do it.

The question is different. Classic mutation testing mutates everything and
reports a score. TestGuard binds every fault to a **stated claim**. So the
output is a finding, not a percentage: *"your project says a missing scope
fails closed, and nothing checks that"*. See [how it works](concepts/how-it-works.md)
and [prior art](../docs-canonical/PRIOR-ART.md).

### Does it write tests for me?

No. It judges tests. `admit` tells you whether a test you or your agent wrote
actually fails when the claim is broken. You or your agent still write the
tests. See [writing claims](guides/writing-claims.md).

### Why not just measure coverage?

Coverage says a line ran. It never says anyone checked the result. A test can
cover a line 100% and still ignore the field that matters in its assertion.
TestGuard's own fixture is exactly that case. See the
[known-answer fixture](../fixtures/known-answer/README.md).

### Does a model decide any verdict?

No. Faults are string substitutions from a reviewed file. Verdicts come from
your test runner's structured report, confirmed over N runs. The same inputs
give the same evidence. `scaffold` and `sweep` propose faults with
deterministic line heuristics, not a model.

### Why is `SURVIVED` the bad result?

It is the *fault* that survived, not the test. You broke the code on purpose
and every test stayed green, so no test defends that behaviour. A healthy
report is mostly `killed`. See [verdicts](reference/verdicts.md).

### Why is there no single score?

Blind spots are concentrated in a few places. One number averages a critical
unguarded authorization check with a hundred trivial ones, and it tells you
about neither. TestGuard ranks findings by severity, claim provenance and
blast radius instead.

## Fit

### Which languages and test runners are supported?

JavaScript and TypeScript run under vitest, jest, Playwright and Node's
built-in test runner. Python runs under pytest or stdlib `unittest`. Anything
else runs through `--runner-cmd` if it can write a jest-compatible JSON
report or JUnit XML (`--report-format junit`). See [languages and runners](reference/languages-and-runners.md).

### Do I need claims for the whole codebase first?

No. Gate the delta from day one. Write the first three to five claims where a
silent failure would hurt. Baseline the rest. See
[adopting in an existing project](guides/existing-projects.md).

### Does it work in a monorepo?

Yes. A nested `testguard.claims.json` marks a separate project with its own
gate. See [monorepo](guides/monorepo.md).

### Which AI agents does it work with?

Any agent. `init` installs a skill and a session-start hook for Claude Code.
It also installs an `AGENTS.md` section that Codex and other agents read.
`testguard mcp` serves the read-only loop to any MCP-capable harness. `status --json`
works from anything that can run a shell. See [AI agents](guides/ai-agents.md).

## Safety

### Will it change my code?

Not by default. TestGuard applies each fault in a scratch git worktree. It
never touches your working tree, HEAD or index. `--in-place` is the explicit
exception: it applies faults to your working tree and restores every file
afterwards.

### Does it send anything over the network?

The CLI makes no network calls and collects no telemetry. The session-start
hook resolves an installed binary and never fetches one. Two exceptions exist,
and you opt into both. The GitLab job posts a merge-request note when you set
`post_note`. The `pip` wrapper falls back to `npx` when no local install
exists. See [installation](installation.md) and [PRIVACY.md](../PRIVACY.md).

### What should I commit?

Commit `testguard.claims.json`, `testguard.ignore.json` if you have one, and
`.testguard/baseline.json`. TestGuard regenerates the evidence and the brief
on every run, and they are ignored. See [artifacts](reference/artifacts.md).

### Can my agent make a survivor disappear by editing the claim?

It can edit the claim. It cannot hide that it did. Evidence records every
fault's content hash. `status` lists any fault edited after it survived,
with its previous verdict. `claims --since <ref>` reports deleted claims. See
[how it works](concepts/how-it-works.md).

## Cost

### Why is the probe slow?

A probe runs each fault's defenders N times (three by default), plus a clean
baseline. A slow test that many faults select runs many times. `probe
--cost` shows where the time went. See [performance](guides/performance.md).

### How do I iterate faster?

Use these options:

- `--claim <ID>` probes one claim.
- `--no-escalate` skips the whole-suite re-run of survivors.
- `--confirm 1` gives a provisional answer that `baseline` refuses to freeze.

Run the full default probe before you commit.

## Next

- [Quickstart](quickstart.md)
- [Troubleshooting](troubleshooting.md)
- [Glossary](glossary.md)
