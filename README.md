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

1. **`testguard claims`** — list the claims a project makes: a statement, its
   source, and one or more *faults* that would make it false, each expressed
   as a deterministic source change.
2. **`testguard probe`** — for each fault: confirm the defending tests are
   green unmodified, apply the fault in a scratch git worktree, run the
   defenders N times, restore. Report `killed`, `survived`, `nocover`,
   `unverifiable`, `timeout`, `fault-invalid` or `flaky-defender` — never a
   single score.
3. **`testguard baseline`** — freeze today's survivors so only new ones gate.
4. **`testguard brief`** — emit a ranked blind-spot block for an agent's
   session-start context, so it knows where the suite lies before it writes.

The fault model is the auditable artifact. You never reach 100% of
correctness; you reach **100% of stated claims verified**, and the statement
of claims is what an assessor reads.

## Status

**v0.1 in progress.** The contract spine — six shared JSON Schemas and their
conformance suite — is drafted under [`spec/`](spec/). The CLI is next.

```bash
npm install
npm run test:spec
```

## Licence

MIT.
