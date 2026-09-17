# TestGuard

> Proves that a test suite actually defends the claims a project makes — by
> injecting the faults those claims say cannot happen, and reporting every
> fault the tests fail to detect.

**Not a test generator. A claim verifier.** Test generation is what happens
after a claim turns out to be unfalsifiable.

Third tool following the Guard pattern, alongside
[`docguard-cli`](https://www.npmjs.com/package/docguard-cli) (docs ↔ code) and
[`websec-validator`](https://pypi.org/project/websec-validator/) (attack
surface ↔ code). All three run one loop:

> declare what must be true → try mechanically to falsify it → freeze a
> baseline → gate only the delta → brief the agent before it writes code.

## Why

Coverage cannot tell a test that pins *correct* behaviour from one that pins
a *defect*. An agent that writes both the code and its tests encodes whatever
it believed — including its bugs — and the suite goes green.

Measured on a real, entirely AI-authored production codebase with ~4,900
disciplined tests (no snapshots, 0.4% zero-assertion): **8 of 9 real
historical bugs were invisible to the suite**, worst case 2,451 tests green
on known-broken code. The largest gap was a compliance-critical path with
100% coverage, where the one assertion that mattered used
`expect.objectContaining({...})` and omitted the field carrying the data.

## How it works

```bash
npx testguard-cli claims      # what does this project claim, and is every claim probeable?
npx testguard-cli probe       # try to falsify each claim; report what the tests missed
npx testguard-cli baseline    # freeze today's unproven findings; from now on only new ones gate
npx testguard-cli brief       # tell the agent where the suite is blind, before it writes
```

1. **Claims** live in `testguard.claims.json`: a statement, where it comes
   from, which tests supposedly defend it, and one or more *faults* — each a
   deterministic source change that would make the statement false. Every
   claim and every fault records who produced it. `testguard claims`
   validates the file and reports drift against `@claim <ID>` annotations in
   source.
2. **Probe** confirms the defenders are green N times unmodified, applies
   each fault in a scratch git worktree (your tree is never touched), runs
   the defenders N times, re-runs survivors against the whole suite with
   N-run attribution, restores, and classifies. Verdicts are a closed set:

   | Verdict | Meaning |
   |---|---|
   | `killed` | a test body rejected the behaviour, N/N — the only pass |
   | `SURVIVED` | the defenders stayed green while the claim was false |
   | `NOCOVER` | no test file defends the claim at all |
   | `UNVERIFIABLE` | the fault's anchor is missing or ambiguous — loud, never a skip |
   | `TIMEOUT` | the defenders hung; a hang is not a detection |
   | `FAULT-INVALID` | the replacement does not load — a bad fault, not a finding |
   | `FLAKY-DEFENDER` | the defenders are not reliably green, or disagreed across runs |

   Never a single score. Findings are ranked by severity, claim provenance
   and blast radius, and written to `.testguard/evidence.json` — validated
   against the spec before it is written.
3. **Baseline** freezes every non-passing fingerprint. Later probes suppress
   what was already known and exit non-zero only on what is new. Claims whose
   source and defenders are unchanged reuse their prior verdict, so a probe
   in CI costs only what changed.
4. **Brief** turns evidence plus baseline into a ranked, capped
   `## TEST BLINDSPOT CONTEXT` block. Wire it into an agent's session start
   — for Claude Code, in `.claude/settings.json`:

   ```json
   { "hooks": { "SessionStart": [ { "hooks": [
     { "type": "command", "command": "npx testguard-cli brief --text" }
   ] } ] } }
   ```

   `--text` prints only, and exits 0 silently when there is no evidence yet,
   so the hook can never break a session.

**Commit `.testguard/baseline.json`; ignore `evidence.json` and `brief.json`.**
The baseline is the frozen contract; the other two are regenerated per run.

The fault model is the auditable artifact. You never reach 100% of
correctness; you reach **100% of stated claims verified**, and the statement
of claims is what an assessor reads. A claims file is code — its `replace`
strings run under your test runner — so review it like code.

## Try it

The repository ships a known-answer fixture with a real blind spot:

```bash
git clone <this repo> && cd testguard && npm install
npm test                                  # includes probing the fixture end to end
```

`fixtures/known-answer/` is a tiny project whose audit-row test asserts with
`expect.objectContaining({...})` and omits the `content` key. Swap the
redacted text for the raw input and the test stays green. `probe` reports it
as `SURVIVED`; the fixture's [README](fixtures/known-answer/README.md) walks
through every verdict.

## Status

**v0.1.** Four commands, vitest runner, hand-authored faults. The contract
spine — six JSON Schemas shared with the other Guard tools — is under
[`spec/`](spec/). Zero runtime dependencies; Node ≥ 20.

Not yet: test generation (the two-gate acceptance loop), other runners,
mechanical fault producers, and calibration of fault classes against real
escaped bugs. Each is designed for; none is claimed.

## Licence

MIT.
