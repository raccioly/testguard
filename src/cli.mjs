import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaimsError } from './claims/load.mjs';
import { PreconditionError } from './probe/worktree.mjs';
import { RUNNER_NAMES } from './probe/runners/index.mjs';
import { GitError } from './git.mjs';
import { SpecDocError } from './evidence/writer.mjs';
import { probeCommand } from './commands/probe.mjs';
import { claimsCommand } from './commands/claims.mjs';
import { baselineCommand } from './commands/baseline.mjs';
import { briefCommand } from './commands/brief.mjs';
import { scaffoldCommand } from './commands/scaffold.mjs';
import { statusCommand } from './commands/status.mjs';
import { initCommand } from './commands/init.mjs';
import { gateCommand } from './commands/gate.mjs';
import { replayCommand } from './commands/replay.mjs';
import { mcpCommand } from './commands/mcp.mjs';
import { admitCommand } from './commands/admit.mjs';
import { sweepCommand } from './commands/sweep.mjs';

const VERSION = JSON.parse(readFileSync(join(fileURLToPath(import.meta.url), '..', '..', 'package.json'), 'utf8')).version;
const ISSUES = 'https://github.com/raccioly/testguard/issues';

export const USAGE = `testguard ${VERSION} — proves a test suite defends the claims a project makes

  testguard status [dir]     where the project is and the ONE next action; --json is the machine entry point
  testguard init [dir]       install the agent layer at the git root (skill, session-start hook, AGENTS.md section) and the .gitignore lines in [dir]
  testguard claims [dir]     list claims and drift; --check-anchors also verifies every exact anchor and replacement syntax
  testguard probe [dir]      inject each claim's faults, run its defenders, report what survived
  testguard baseline [dir]   freeze today's unproven findings so only new ones gate
  testguard brief [dir]      emit the blind-spot block for an agent's session-start context
  testguard gate [dir]       fail when a changed source file carries no claim and no excusing ignore entry
  testguard scaffold <file>  propose faults mechanically for one source file, as a draft claims document
  testguard sweep [dir]      propose faults for the changed source files that carry no claim, probe a bounded selection, and report what nothing noticed
  testguard mcp              serve the read-only status/brief/claims/evidence tools over MCP on stdio, so the loop works in any agent harness
  testguard replay [dir]     would this suite have caught the bugs that already escaped? Replays real fix commits and calibrates fault classes against them
  testguard admit <test> --claim <ID>   the two-gate rule as one verb: is this test green on HEAD and does it fail on every fault of the claim?

probe
  --claims <path>      claims file             (default: <dir>/testguard.claims.json)
  --confirm <n>        runs per verdict        (default: 3)
  --budget <ms>        wall clock per run      (default: 120000)
  --out <path>         evidence file           (default: <dir>/.testguard/evidence.json)
  --baseline <path>    baseline to gate against (default: <dir>/.testguard/baseline.json if present)
  --severity <level>   gate only at or above   (default: low)
  --ref <commit>       probe this commit in the scratch worktree (default: HEAD). An explicit --ref is honoured even when
                       defender/target files are dirty: a warning names them, the evidence records them (repo.ignoredDirty)
  --ignore-dirty       probe HEAD as committed although defender/target files are dirty (same warning and record)
  --claim <ID,ID>      probe only these claims; repeatable, order-preserving, and writes .testguard/evidence-partial.json
  --include-dirty      probe the working tree (a snapshot commit) instead of HEAD; uncommitted tests count
                       (without it, a dirty defender/target with the implicit HEAD is refused: the silent-mismatch trap)
  --verbose            also print each killed fault (default: only unproven ones, plus a count)
  --cost               (probe, claims) report what the defenders cost, per claim and per defender file
  --progress <mode>    auto|tty|plain|ndjson|none. auto rewrites one line at a terminal and prints
                       append-only lines everywhere else, so a redirected log and CI see progress
                       instead of twenty silent minutes. Always on stderr; ndjson also streams verdicts
                       --confirm below 3 is PROVISIONAL: verdicts print with "?", evidence goes to .testguard/evidence-provisional.json
  --runner <name>      vitest | jest | playwright | python | pytest | unittest | auto
                       (default: auto — first of vitest, jest, python that resolves. A defender under playwright's testDir
                       always runs under playwright, and a .py defender always under python, whatever the project runner.
                       python picks pytest when the interpreter can import it and stdlib unittest otherwise; pytest and
                       unittest pin that choice and fail rather than fall back. The engine that ran is what the evidence records.)
  --runner-cmd "<cmd>" custom runner; must contain {files} and {out}, e.g. "pnpm vitest run {files} --reporter=json --outputFile={out}"
  --node-modules <dir> node_modules to link into the scratch worktree (or TESTGUARD_NODE_MODULES)
  --python <path>      Python interpreter for .py defenders (or TESTGUARD_PYTHON; default: $VIRTUAL_ENV, then the project's
                       .venv/venv, then python3 on PATH). Resolved against your working tree, never the scratch worktree.
  --serial             run one test file at a time (vitest --no-file-parallelism, jest --runInBand, playwright --workers=1,
                       pytest -p no:xdist);
                       use it when another test runner is already running — probe warns and records the contention either way
  --in-place           mutate the working tree instead of a scratch worktree
  --no-escalate        do not re-run survivors against the whole suite
  --no-reuse           re-probe claims whose inputs have not changed
  --quiet              suppress the per-fault stream and ranked block; print only the summary and evidence path
  --json               the status document plus this run's result (records, newSinceBaseline, exitCode)

scaffold   --claim <ID> (put every proposal under this claim; copies it if it exists)  --out <path>  --json
sweep      --changed <ref> (required; CI bases and a safe local default are detected)  --cap <n> (default 7 x unclaimed files)
           --include-dirty  --exclude <glob>  --confirm <n>  --budget <ms>  --max <n>  --out <path>  --json
           the cold start: no claim and no concern needed. Everything it proposes is a DRAFT — it never writes testguard.claims.json,
           and its evidence never replaces .testguard/evidence.json. exit 1 on a fault that survived, or a file no test imports
           shapes: if-guard → if (false) · single-line guard/mutation removed · return <check> → return true
                   · security flag/window/cost literal weakened · verify/validate/check call removed
                   · field dropped from a payload/allow-list/schema/merge · parameter-derived argument swapped for undefined/{}
mcp        no options. JSON-RPC 2.0 over stdio; five READ-ONLY tools (status, brief, claims, evidence, next_command).
           Nothing here runs a probe: next_command hands back the shell line for you to run where the person can see it.
           Register it with your harness — testguard init --mcp prints the config for Claude Code, Cursor and Codex.
replay     --since <range>   commit range to search for fix commits (HEAD~50..HEAD, a tag, origin/main..HEAD)
           --max <n>         replay at most n fixes (they are slow: one worktree and N runs each)
           --confirm <n>     runs per verdict (default 3); a flaky failure reads as "the suite caught it", so mixed runs are never caught
           --out <path>       replay document (default: <dir>/.testguard/replay.json); the calibration goes beside it
           reports, never gates: a bug that escaped is history, not a regression in this change
                   · one-line JSX element removed · on<Event> handler prop dropped
admit      --claim <ID> (required)  --fault <FID> (one fault only)  --confirm <n>  --json
           ADMITTED (exit 0) only when every fault of the claim is killed N/N by defenders that are green N/N; anything else is NOT ADMITTED (exit 1) and names the first blocking fault
           the test must be a declared or discovered defender of the claim (exit 3 otherwise); evidence goes to .testguard/evidence-partial.json
gate       --changed <ref>   measure the change since merge-base(ref, HEAD); auto-detected in GitHub Actions / GitLab CI
           --include-dirty   compare the working tree (staged, unstaged and untracked) instead of HEAD; needs a reference, so the pre-commit shape is: gate --changed HEAD --include-dirty
           --exclude <glob>  (repeatable) more files that never carry claims; --explain lists the defaults
           --strict          a non-empty change that evaluates nothing is a failure, not a note
           --ignore <path>   ignore file (default: <dir>/testguard.ignore.json; kind=path entries excuse files, with a reason)
           exit 0 every changed source file is claimed or excused · 1 unclaimed file · 2 cannot evaluate · 3 no reference
claims     --check-anchors   locate every fault without running tests; JS/MJS and Python replacements are syntax-checked in memory
           --json includes anchorChecks; exit 1 when an anchor is missing/ambiguous or a supported replacement does not compile
status     --json (exit 0 clean · 1 unproven/stale/unclaimed/invalid anchors · 2 nothing to probe yet)
           --evidence <path>  read this evidence instead of .testguard/evidence.json (e.g. CI's, fetched as an artifact); staleness is still computed from the recorded input hashes, and both commits are named
           --changed <ref>   also compute claim coverage of the change; unclaimed-changes then precedes every evidence state
init       --force (replace an existing skill file)  --here (keep the agent layer in [dir] instead of the git root)  --json
           --ci-evidence github|gitlab   write .testguard/fetch-ci-evidence.sh, an ON-DEMAND helper that downloads CI's evidence artifact and briefs from it; the session-start hook stays offline
           agent layer (skill, SessionStart hook, AGENTS.md section) → git root; project layer (.gitignore lines) → [dir]
           the hook prefers a local install, then a testguard already on PATH, then nothing; it never reaches the network. exit 1 if a written file is gitignored
           --mcp             print the MCP server config for Claude Code, Cursor and Codex (printed, never written: a harness config is yours)
every command accepts --json; probe/baseline emit the status document plus their own result
claims     --json
           --cost            what the last probe spent, per claim and per defender file, read back from the recorded run durations. Names the files more than one claim pays for, which is where a slow gate comes from
           --since <ref>     report every claim and fault that existed at <ref> and does not now; a claim entry in testguard.ignore.json (with a reason) excuses one. exit 1 on any unexcused removal
baseline   --evidence <path>  --out <path>  --allow-provisional (freeze unconfirmed evidence; normally refused)
           --restamp          move head to the commit of a later CLEAN probe that reproduced the same fingerprints
                              (a baseline frozen from a snapshot points at the parent of the commit that carries its tests)
brief      --evidence <path>  --baseline <path>  --max <n>  --text (print only; safe for hooks)  --markdown (print only, as a merge-request note)

exit codes: 0 nothing new to prove · 1 unproven claims (or claim drift, or unclaimed changes) · 2 precondition failed · 3 usage
`;

const COMMANDS = { mcp: mcpCommand, replay: replayCommand, probe: probeCommand, claims: claimsCommand, baseline: baselineCommand, brief: briefCommand, scaffold: scaffoldCommand, status: statusCommand, init: initCommand, gate: gateCommand, admit: admitCommand, sweep: sweepCommand };

export async function main(argv, io = { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') }) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        claims: { type: 'string' },
        confirm: { type: 'string', default: '3' },
        budget: { type: 'string', default: '120000' },
        out: { type: 'string' },
        evidence: { type: 'string' },
        baseline: { type: 'string' },
        severity: { type: 'string', default: 'low' },
        max: { type: 'string', default: '20' },
        ref: { type: 'string' },
        'ignore-dirty': { type: 'boolean', default: false },
        serial: { type: 'boolean', default: false },
        claim: { type: 'string', multiple: true },
        fault: { type: 'string' },
        'include-dirty': { type: 'boolean', default: false },
        changed: { type: 'string' },
        since: { type: 'string' },
        exclude: { type: 'string', multiple: true },
        cap: { type: 'string' },
        strict: { type: 'boolean', default: false },
        explain: { type: 'boolean', default: false },
        ignore: { type: 'string' },
        'allow-provisional': { type: 'boolean', default: false },
        restamp: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        mcp: { type: 'boolean', default: false },
        'ci-evidence': { type: 'string' },
        here: { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        'runner-cmd': { type: 'string' },
        python: { type: 'string' },
        runner: { type: 'string', default: 'auto' },
        'node-modules': { type: 'string' },
        'in-place': { type: 'boolean', default: false },
        'no-escalate': { type: 'boolean', default: false },
        'no-reuse': { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        text: { type: 'boolean', default: false },
        markdown: { type: 'boolean', default: false },
        cost: { type: 'boolean', default: false },
        'check-anchors': { type: 'boolean', default: false },
        progress: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (e) {
    io.err(e.message);
    io.err(USAGE);
    return 3;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.out(VERSION);
    return 0;
  }
  const [command, dirArg] = positionals;
  if (values.help || !command) {
    io.out(USAGE);
    return command ? 0 : 3;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    io.err(`unknown command: ${command}`);
    io.err(USAGE);
    return 3;
  }
  if (![...RUNNER_NAMES, 'auto'].includes(values.runner)) {
    io.err(`--runner must be one of ${RUNNER_NAMES.join(', ')} or auto`);
    return 3;
  }
  if (!['critical', 'high', 'medium', 'low'].includes(values.severity)) {
    io.err('--severity must be one of critical, high, medium, low');
    return 3;
  }
  try {
    const projectDir = command === 'scaffold' || command === 'admit' ? resolve('.') : resolve(dirArg ?? '.');
    return await handler({ projectDir, file: dirArg, values, version: VERSION }, io);
  } catch (e) {
    if (e instanceof ClaimsError || e instanceof PreconditionError || e instanceof GitError || e instanceof SpecDocError) {
      io.err(`error: ${e.message}`);
      return 2;
    }
    // Anything else is a defect in testguard, not a finding about the project.
    // A bare Node trace reads as "your repository broke the tool" and gives the
    // operator nothing to do, so name it as ours in the first line. The trace
    // still goes out: it is the only part of this that makes a report
    // actionable, and swallowing it would trade one unusable output for another.
    io.err(`error: this is a bug in testguard ${VERSION}, not a problem with your project.`);
    io.err(`Please report it at ${ISSUES} with the command you ran and the trace below.`);
    io.err(e?.stack ?? String(e));
    return 2;
  }
}
