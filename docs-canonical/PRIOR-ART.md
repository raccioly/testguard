# Prior Art

<!-- docguard:version 1.0.0 -->
<!-- docguard:status approved -->
<!-- docguard:last-reviewed 2026-09-22 -->
<!-- docguard:owner @raccioly -->
<!-- docguard:quality passive-voice off — the subject of this document is what was taken from other people's work. "Diff scoping was taken from Google" is the true sentence; rewriting every one to name us as the actor would put the borrower in the foreground of a document about the lender. -->
<!-- docguard:quality negation-load off — half the value here is what was deliberately NOT taken: not their mutation score, not their equivalence auto-drop, not a model judging a verdict. A record of borrowings that only lists borrowings is the half that misleads. -->

> Canonical. Every mechanism in this tool that came from somewhere else is
> recorded here, with what was taken and what was left. A design that cannot
> say where it came from cannot say what is new about it.

## Why this document exists

TestGuard is not the first tool to break code to test the tests. Mutation
testing dates to the 1970s, and two industrial programmes solved the parts
that make it usable at scale. Several of this tool's design decisions are
theirs. Recording that is not modesty: it is how a reviewer distinguishes a
mechanism with a decade of evidence behind it from one invented here last
week, and it is how a future maintainer knows which numbers are ours and which
are borrowed.

The rule for this file: a borrowed mechanism names its source, states what was
taken, and states what was deliberately **not** taken. A measured number says
who measured it.

## Mutation testing, generally

| Work | Relationship |
|---|---|
| DeMillo, Lipton & Sayward (1978); Hamlet (1977) | The original idea: seed artificial faults, and a test suite that does not detect them is inadequate. |
| Stryker, PIT, mutmut, Cosmic Ray | Mature, well-engineered mutation testing tools. They mutate exhaustively and report a score. TestGuard does neither — see [Deliberate differences](#deliberate-differences). |

## Google — making it affordable

**Petrović, Ivanković, Fraser & Just, _Practical Mutation Testing at Scale: A
view from Google_** (2021) — <https://arxiv.org/abs/2102.11378>
**Petrović & Ivanković, _State of Mutation Testing at Google_** (ICSE-SEIP
2018) — <https://research.google.com/pubs/archive/46584.pdf>
**Petrović, Ivanković, Fraser & Just, _Does mutation testing improve testing
practices?_** (2021) — <https://arxiv.org/abs/2103.07189>

Mutating a two-billion-line repository is infeasible, and their reported
numbers are the reason several of our defaults are what they are.

| Taken | Where it lives here |
|---|---|
| **Diff scoping** — mutate only changed lines, surfaced during code review. | `gate --changed`, and `sweep`, which proposes only for changed files. |
| **A hard cap on what is surfaced** — at most 7 × the number of files in the change, because past that the reader stops reading. | `capFor()` in `src/supply/select.mjs`; the remainder is reported as `deferred`, never dropped. |
| **Productivity-ordered selection** — order candidates by how often that operator produced a useful mutant in similar context. Developer feedback over six years took their productive rate from **15% to 89%**. | `MEASURED_PRODUCTIVITY` and `scoreOf()` in `src/supply/select.mjs`. Ours is measured on 56 probed faults from a real AI-authored codebase and shrunk toward a neutral prior, so one observation cannot dominate. |
| **Arid-node suppression** — do not mutate code nobody would write a test for (logging, timeouts, config flags). | Partially: our producers are line-oriented and never propose on comments or blank lines, and `testguard.ignore.json` carries path exclusions with reasons. We have no AST-level arid heuristic. |
| **Fault coupling as the justification** — their 2021 study found reported mutants are coupled to real faults: bugs they analysed would have been caught had a mutant been surfaced. | The premise behind `replay`, which calibrates fault classes against real fix commits rather than assuming the coupling. |

**Not taken.** Their mutation score, their exhaustive per-line generation, and
their AST-based arid heuristics (ours is a different scale and a different
language surface). Their selection learns from explicit developer feedback;
**ours learns from the project's own probed verdicts** (v0.13.0) — every
evidence record already carries a fault class and a verdict, so the feedback
is a tally rather than a thing to collect. The combination is a Beta-Binomial
posterior mean, which is strictly proper; see the Laya section.

## Meta — making it specific

**Foster, Alshahwan, Gula, Harman, Mao, Payne, Rogers, Sengupta et al.,
_Mutation-Guided LLM-based Test Generation at Meta_** (FSE 2025) —
<https://arxiv.org/abs/2501.12862>
**Beller, Wong, Bader, Scott, Machalica, Chandra & Meijer, _What It Would Take
to Use Mutation Testing in Industry — A Study at Facebook_** (ICSE-SEIP 2021)
— <https://arxiv.org/abs/2010.13464>
**Alshahwan et al., _Automated Unit Test Improvement using LLMs at Meta_**
(FSE 2024) — <https://arxiv.org/abs/2402.09171>

ACH inverts the generator: rather than mutating everything, an engineer writes
an **area of concern** in plain text, a model drafts faults specific to that
concern, and every step is gated by execution.

| Taken | Where it lives here |
|---|---|
| **The concern as the unit a human writes.** One plain-text sentence generates faults across a whole surface. | `testguard.concerns.json` and `sweep --concern` (v0.13.0). Taken WITHOUT the generator: a concern's core is a named scope plus a producer selection, which the mechanical producers already satisfy, so it ships offline. On a real application a five-line concern found an admin route whose owner/manager check can be forced to `false` with no test failing. |
| **An execution gate between every model step and the record.** A drafted fault must build, must survive the existing suite, and must not be equivalent before a test is generated for it; the generated test must build, pass on the original N times, and kill the fault. | The rule that nothing a model proposes enters `testguard.claims.json` without passing `probe` and a human keep — already how `scaffold` drafts work. |
| **Show the reviewer the fault as proof.** The engineer sees the concrete fault the test catches, so the model's output is independently checkable rather than self-referential. | Every finding names its fault, its anchor and its reproducer; `admit` reports which fault a candidate test kills. |
| **Learned, realistic faults rather than syntactic ones** (Beller 2021: operators learned from a corpus of real Java errors and from changes that caused operational anomalies; **>50% of 15,000 generated mutants survived** their suite). | The premise behind `replay`'s fault-class calibration, and behind the planned intent-based producer. Our built-in producers remain deterministic and line-oriented. |

**Not taken.** Their LLM equivalence detector (0.79/0.47 precision/recall,
0.95/0.96 after preprocessing) — we report suspicion to a human instead of
auto-dropping. Their acceptance-rate metric (73%) is theirs, not a number we
have reproduced.

## Why no model decides a verdict

**SpecBench** — <https://arxiv.org/abs/2605.21384> — measured that coding
agents saturate the tests they can see, with the gap to held-out tests growing
about 28 points per tenfold increase in code size. That is the failure this
tool exists to detect, and it is also the reason a model is not allowed to
judge here.

We tested the alternative rather than asserting it. A calibrated commercial
decision model (TypeSafe Jev) was shadow-evaluated against real probed
verdicts:

| Dataset | AUC | Survivors misread as caught |
|---|---|---|
| Hand-built known-answer fixtures | 0.896 | 0 of 9 |
| A real AI-authored codebase, 53 probed faults | **0.813** | **9 of 16** |

Two conclusions, both recorded because both cost real time to learn:

1. **The errors ran in the forbidden direction** — confidently reporting that a
   test would catch a fault that in fact survived. That is precisely the
   optimistic bias this tool exists to remove.
2. **A synthetic fixture flatters any judge.** The fixture number was ~0.08 AUC
   higher and showed a zero-false-positive property that does not exist on real
   code, because a fixture's blind spots were authored to be legible. Any future
   evaluation of a heuristic or model must use `scaffold` → `probe` on a real
   repository.

Supporting calibration evidence, independently measured:
<https://github.com/scienthoon/jev-ood-calibration> — out of distribution,
boolean questions were *under*-confident (refit temperature 0.66, the safe
direction) while choice (T=3.29) and ordinal score (T=3.40, 44.7% accurate at a
mean stated probability of 0.74) were badly over-confident.

## Laya — calibration as a training objective

**Laya** (Convai Innovations, Apache-2.0) — <https://github.com/NandhaKishorM/laya>

The model is not used here. Three of its design principles are.

| Taken | Where it applies |
|---|---|
| **Strictly proper scoring rules as the objective.** Their stated rationale: naive optimisation maximises accuracy by destroying calibration, producing a confidently wrong model. A strictly proper scoring rule is maximised only by honest probabilities. | A binding constraint on the planned ranker feedback loop: it must optimise Brier or log score, never accuracy or F1. |
| **A separate act/escalate channel**, distinct from the answer's own confidence. | Already the architecture of `classify()`: `killed`/`survived` and `unverifiable`/`nocover`/`flaky-defender` are different kinds of answer, not confident and unconfident versions of one. Recorded here so it is defended rather than collapsed. |
| **Out-of-distribution is invisible to confidence** — their English checkpoint scored 0.000 accuracy at 95.2% confidence on Khmer. Detection must be structural and must precede inference. | Why `scaffold` returns nothing rather than guessing, and why `sweep` reports `skipped: no line in this file matches a fault producer` instead of an empty result. |

## Deliberate differences

What none of the prior art does, and what this tool is for: **binding every
fault to a stated promise**. Classic mutation testing asks "how good are my
tests?" and answers with a number. Google's programme asks the same question,
affordably, per change. Meta's ACH asks it per concern. TestGuard asks "is
*this specific promise* defended?" and answers with a finding that names the
promise, the fault, the defenders and the reproducer.

A score compresses everything into one number that cannot say which promise is
at risk. A claim-bound finding keeps the finding attributable. That is the
difference between a metric and an audit.

## Known gaps in what we borrowed

Recorded so they are not mistaken for decisions.

- **The feedback loop learns from verdicts, not from explicit developer
  clicks.** Google's gain came from "Please fix" / "Not useful" feedback on
  surfaced mutants. Ours reads survival per fault class from the project's own
  evidence — the same signal, but it cannot yet distinguish a survivor the
  developer *acted on* from one they ignored. A keep/drop record would close
  that.
- **Concerns have no model-backed producer.** The unit shipped; the ACH
  generator that drafts intent-level faults for a concern did not, and is the
  one piece of the rung that would touch the network.
- **No arid-node heuristic.** We suppress by path, not by AST shape.
- **The persistence signal is confined to the sweep document.** It is not yet
  in `evidence.defenders.signals`, which is a closed enum in the shared
  claimspec contract and needs a coordinated bump.
