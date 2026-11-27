# MCP server reference

`testguard mcp` serves TestGuard's read-only documents over the Model Context
Protocol. So the operating loop works in any agent harness, not only the one
that runs the session-start hook. Use this page to connect it to Claude Code,
Cursor, Codex or another MCP client. It is also for anyone who writes code
against its tools. The [AI agents guide](../guides/ai-agents.md) explains how
an agent uses the tools day to day.

```bash
npx testguard-cli mcp            # JSON-RPC 2.0 on stdio
npx testguard-cli init --mcp     # print the config for Claude Code, Cursor and Codex
```

## Why no tool runs a probe

Every tool is read-only, and none of them runs a test. A probe is
long-running and budgeted, and the person should see it happen. So
`testguard_next_command` gives the agent the exact shell line to run in its own
terminal instead. No tool writes a file either. Editing a claims file through
a connector would bypass the record TestGuard keeps of every fault edit. The
server declares only a `tools` capability: no prompts, no resources, no
sampling.

The server is hand-written against a pinned protocol version. It does not use
the official SDK, because TestGuard keeps one exact-pinned runtime dependency.
Tests speak the wire format to a real child process. They check each tool
against the CLI's own `--json` output, so the two cannot drift.

## Register the server

`testguard init --mcp` prints these snippets. It writes none of them, because
a harness's configuration is your file, and often a global one. Add the
snippet for your harness yourself.

**Claude Code**: `.mcp.json` in the project root, or `claude mcp add`.

```json
{
  "mcpServers": {
    "testguard": {
      "command": "npx",
      "args": [
        "-y",
        "testguard-cli",
        "mcp"
      ]
    }
  }
}
```

**Cursor**: `.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "testguard": {
      "command": "npx",
      "args": [
        "-y",
        "testguard-cli",
        "mcp"
      ]
    }
  }
}
```

**Codex CLI**: `~/.codex/config.toml`.

```toml
[mcp_servers.testguard]
command = "npx"
args = ["-y", "testguard-cli", "mcp"]
```

These snippets launch the server through `npx -y`. It fetches the package from
the registry if the package is not installed. That happens once, when the
harness starts the server. The tools themselves make no network calls. Every
tool's `dir` defaults to the directory where the harness starts the server.

## Protocol

| Property | Value |
|---|---|
| Transport | stdio, newline-delimited JSON-RPC 2.0 (one message per line) |
| Protocol version | `2025-06-18` |
| Capabilities | `{ "tools": { "listChanged": false } }` |
| Server info | `{ "name": "testguard", "version": "<installed version>" }` |
| Methods | `initialize`, `tools/list`, `tools/call`, `ping`. The server accepts the notifications `notifications/initialized` and `notifications/cancelled` and never answers them. |
| Tool annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false` on every tool |

The `initialize` result carries these instructions for the client:

> Read testguard_status first: it carries the one next action. Run the command
> it names in your own terminal — these tools never run a probe, because a
> probe is long-running, budgeted, and the person should see it happen.

A successful `tools/call` returns the document twice: as JSON text in
`content[0].text` and as `structuredContent`. A tool that fails returns a
normal result with `isError: true` and the text `<tool> failed: <reason>`. So
the agent can read the reason and act without losing the connection. Protocol
errors use the standard JSON-RPC codes: `-32700` invalid JSON, `-32600` a
request that is not an object, `-32601` an unknown method, `-32602` an unknown
tool, `-32603` an internal error. One bad request never stops the server.

`testguard mcp` takes no options. It refuses `--json` with exit `3`, because
anything printed on stdout would corrupt the protocol stream. It exits `0`
when stdin closes.

## Tools

Every tool rejects arguments it does not list. Three arguments recur:

| Argument | Type | Meaning |
|---|---|---|
| `dir` | string | Project directory, where `testguard.claims.json` lives. Defaults to the server's working directory. |
| `changed` | string | A git reference to measure the change against. The result then includes claim coverage of the change. Without it, the server detects the reference the way the CLI does (see [gate](cli.md#gate)). |
| `evidence` | string | Read this evidence document instead of `<dir>/.testguard/evidence.json`. For example, read the evidence from CI, fetched as an artifact. |

### testguard_status

Where the project stands, and the one next action. It returns the same
document as `testguard status --json`. This document is the single source of
truth: every other rendering derives from it. Read it before you decide
anything.

| Input | Output |
|---|---|
| `dir`, `changed`, `evidence` | The status document ([`status.schema.json`](../../spec/schemas/status.schema.json)): `state`, `next {action, command, why}`, counts, stale inputs, faults edited since they were probed, ranked findings. |

### testguard_brief

Where the suite is blind, ranked and capped, with one hint per finding and
unclaimed changed files first. It has the same content as the session-start
hook prints.

| Input | Output |
|---|---|
| `dir`, `changed`, `evidence`, `max` (integer 1–50, default 20) | The brief document ([`brief.schema.json`](../../spec/schemas/brief.schema.json)). With no evidence, the output is the unclaimed-changes brief if there are unclaimed changes. Otherwise it is `{note, next}`. The baseline is always `<dir>/.testguard/baseline.json` when present. |

### testguard_claims

What the project claims, each claim with its faults and defenders, and drift
against `@claim` annotations in source.

| Input | Output |
|---|---|
| `dir`, `since` (a git reference) | `{path, claims, drift}`. When `since` is given, the output also has `removed`: every claim or fault that existed at that reference and does not now, with `claim` and `fault` entries in `<dir>/testguard.ignore.json` applied. With no claims file, the output is `{path, claims: [], note}`. The tool always reads `<dir>/testguard.claims.json`. |

### testguard_evidence

One run's findings on disk: every verdict with the runs that produced it. The
whole document can be large, so ask for one claim when you can.

| Input | Output |
|---|---|
| `dir`, `evidence`, `claim`, `fault` (with `claim`) | The evidence document ([`evidence.schema.json`](../../spec/schemas/evidence.schema.json)). With `claim`, only that claim's records (and with `fault`, only that fault's), plus `filtered: {claim, fault?}`. With no evidence, the output is `{note, path}`. |

### testguard_next_command

The exact shell command to run next, with the reason. It never runs anything.

| Input | Output |
|---|---|
| `dir`, `changed`, `evidence` | `{state, action, command, why, target?, file?, loop, advice?}`: the status document's `next`; `loop`, the commands an agent runs between steps (`afterChangingCode`: `testguard probe --changed auto`, `whileWritingOneTest`: `testguard probe --claim <ID> --confirm 1`, `beforeCommittingATest`: `testguard admit <test-file> --claim <ID>`, `full`: `testguard probe`, and `rule`: the full probe only when the person asks, or nightly); and the status document's `advice`, when it has any. |

A call and its answer, on the known-answer fixture:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"testguard_next_command","arguments":{}}}
```

```json
{
  "state": "invalid-anchors",
  "action": "repair-fault",
  "command": "testguard claims --check-anchors",
  "why": "2 fault anchors no longer locate exactly. Repair REDACT-005/F1 in testguard.claims.json without changing what the fault means, then re-probe.",
  "target": { "claimId": "REDACT-005", "subjectId": "F1", "file": "src/redact.mjs" },
  "loop": {
    "afterChangingCode": "testguard probe --changed auto",
    "whileWritingOneTest": "testguard probe --claim <ID> --confirm 1",
    "beforeCommittingATest": "testguard admit <test-file> --claim <ID>",
    "full": "testguard probe",
    "rule": "Run the full probe only when the person asks for it, or in the nightly job. Faults already run in parallel; do not pass --serial."
  }
}
```

## Next

- [AI agents guide](../guides/ai-agents.md): the loop an agent runs with these tools.
- [CLI reference](cli.md): the commands `next_command` hands back.
- [Verdicts and signals](verdicts.md): the values inside status, brief and evidence.
