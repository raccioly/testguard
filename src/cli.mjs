import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaimsError } from './claims/load.mjs';
import { PreconditionError } from './probe/worktree.mjs';
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
import { admitCommand } from './commands/admit.mjs';

const VERSION = JSON.parse(readFileSync(join(fileURLToPath(import.meta.url), '..', '..', 'package.json'), 'utf8')).version;

const USAGE = `testguard ${VERSION} — proves a test suite defends the claims a project makes

  testguard status [dir]     where the project is and the ONE next action; --json is the machine entry point
  testguard init [dir]       install the agent layer at the git root (skill, session-start hook, AGENTS.md section) and the .gitignore lines in [dir]
  testguard claims [dir]     list the claims file and report drift against @claim annotations in code
  testguard probe [dir]      inject each claim's faults, run its defenders, report what survived
  testguard baseline [dir]   freeze today's unproven findings so only new ones gate
  testguard brief [dir]      emit the blind-spot block for an agent's session-start context
  testguard gate [dir]       fail when a changed source file carries no claim and no excusing ignore entry
  testguard scaffold <file>  propose faults mechanically for one source file, as a draft claims document
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
  --claim <ID,ID>      probe only these claims; writes .testguard/evidence-partial.json
  --include-dirty      probe the working tree (a snapshot commit) instead of HEAD; uncommitted tests count
                       (without it, a dirty defender/target with the implicit HEAD is refused: the silent-mismatch trap)
  --verbose            also print each killed fault (default: only unproven ones, plus a count)
                       --confirm below 3 is PROVISIONAL: verdicts print with "?", evidence goes to .testguard/evidence-provisional.json
  --runner <name>      vitest | jest | auto (default: auto — first of vitest, jest that resolves)
  --runner-cmd "<cmd>" custom runner; must contain {files} and {out}, e.g. "pnpm vitest run {files} --reporter=json --outputFile={out}"
  --node-modules <dir> node_modules to link into the scratch worktree (or TESTGUARD_NODE_MODULES)
  --in-place           mutate the working tree instead of a scratch worktree
  --no-escalate        do not re-run survivors against the whole suite
  --no-reuse           re-probe claims whose inputs have not changed
  --quiet              suppress the per-fault stream and ranked block; print only the summary and evidence path

scaffold   --claim <ID> (put every proposal under this claim; copies it if it exists)  --out <path>  --json
           shapes: if-guard → if (false) · single-line guard/mutation removed · return <check> → return true
                   · security flag/window/cost literal weakened · verify/validate/check call removed
                   · field dropped from a payload/allow-list/schema/merge · parameter-derived argument swapped for undefined/{}
admit      --claim <ID> (required)  --fault <FID> (one fault only)  --confirm <n>  --json
           ADMITTED (exit 0) only when every fault of the claim is killed N/N by defenders that are green N/N; anything else is NOT ADMITTED (exit 1) and names the first blocking fault
           the test must be a declared or discovered defender of the claim (exit 3 otherwise); evidence goes to .testguard/evidence-partial.json
gate       --changed <ref>   measure the change since merge-base(ref, HEAD); auto-detected in GitHub Actions / GitLab CI
           --include-dirty   compare the working tree (staged, unstaged and untracked) instead of HEAD — the pre-commit shape
           --exclude <glob>  (repeatable) more files that never carry claims; --explain lists the defaults
           --strict          a non-empty change that evaluates nothing is a failure, not a note
           --ignore <path>   ignore file (default: <dir>/testguard.ignore.json; kind=path entries excuse files, with a reason)
           exit 0 every changed source file is claimed or excused · 1 unclaimed file · 2 cannot evaluate · 3 no reference
status     --json (exit 0 clean · 1 unproven/stale/unclaimed · 2 nothing to probe yet)
           --evidence <path>  read this evidence instead of .testguard/evidence.json (e.g. CI's, fetched as an artifact); staleness is still computed from the recorded input hashes, and both commits are named
           --changed <ref>   also compute claim coverage of the change; unclaimed-changes then precedes every evidence state
init       --force (replace an existing skill file)  --here (keep the agent layer in [dir] instead of the git root)  --json
           --ci-evidence github|gitlab   write .testguard/fetch-ci-evidence.sh, an ON-DEMAND helper that downloads CI's evidence artifact and briefs from it; the session-start hook stays offline
           agent layer (skill, SessionStart hook, AGENTS.md section) → git root; project layer (.gitignore lines) → [dir]
           the hook prefers a local install, falls back to npx --no-install, never fetches; exit 1 if a written file is gitignored
every command accepts --json; probe/baseline emit the status document plus their own result
claims     --json
           --since <ref>     report every claim and fault that existed at <ref> and does not now; a claim entry in testguard.ignore.json (with a reason) excuses one. exit 1 on any unexcused removal
baseline   --evidence <path>  --out <path>  --allow-provisional (freeze unconfirmed evidence; normally refused)
           --restamp          move head to the commit of a later CLEAN probe that reproduced the same fingerprints
                              (a baseline frozen from a snapshot points at the parent of the commit that carries its tests)
brief      --evidence <path>  --baseline <path>  --max <n>  --text (print only; safe for hooks)  --markdown (print only, as a merge-request note)

exit codes: 0 nothing new to prove · 1 unproven claims (or claim drift, or unclaimed changes) · 2 precondition failed · 3 usage
`;

const COMMANDS = { probe: probeCommand, claims: claimsCommand, baseline: baselineCommand, brief: briefCommand, scaffold: scaffoldCommand, status: statusCommand, init: initCommand, gate: gateCommand, admit: admitCommand };

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
        claim: { type: 'string' },
        fault: { type: 'string' },
        'include-dirty': { type: 'boolean', default: false },
        changed: { type: 'string' },
        since: { type: 'string' },
        exclude: { type: 'string', multiple: true },
        strict: { type: 'boolean', default: false },
        explain: { type: 'boolean', default: false },
        ignore: { type: 'string' },
        'allow-provisional': { type: 'boolean', default: false },
        restamp: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        'ci-evidence': { type: 'string' },
        here: { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        'runner-cmd': { type: 'string' },
        runner: { type: 'string', default: 'auto' },
        'node-modules': { type: 'string' },
        'in-place': { type: 'boolean', default: false },
        'no-escalate': { type: 'boolean', default: false },
        'no-reuse': { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        text: { type: 'boolean', default: false },
        markdown: { type: 'boolean', default: false },
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
  if (!['vitest', 'jest', 'auto'].includes(values.runner)) {
    io.err('--runner must be vitest, jest or auto');
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
    throw e;
  }
}
