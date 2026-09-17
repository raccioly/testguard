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

const VERSION = JSON.parse(readFileSync(join(fileURLToPath(import.meta.url), '..', '..', 'package.json'), 'utf8')).version;

const USAGE = `testguard ${VERSION} — proves a test suite defends the claims a project makes

  testguard status [dir]     where the project is and the ONE next action; --json is the machine entry point
  testguard init [dir]       install the agent layer: skill, session-start hook, AGENTS.md section, .gitignore lines
  testguard claims [dir]     list the claims file and report drift against @claim annotations in code
  testguard probe [dir]      inject each claim's faults, run its defenders, report what survived
  testguard baseline [dir]   freeze today's unproven findings so only new ones gate
  testguard brief [dir]      emit the blind-spot block for an agent's session-start context
  testguard scaffold <file>  propose faults mechanically for one source file, as a draft claims document

probe
  --claims <path>      claims file             (default: <dir>/testguard.claims.json)
  --confirm <n>        runs per verdict        (default: 3)
  --budget <ms>        wall clock per run      (default: 120000)
  --out <path>         evidence file           (default: <dir>/.testguard/evidence.json)
  --baseline <path>    baseline to gate against (default: <dir>/.testguard/baseline.json if present)
  --severity <level>   gate only at or above   (default: low)
  --ref <commit>       probe this commit in the scratch worktree (default: HEAD)
  --claim <ID,ID>      probe only these claims; writes .testguard/evidence-partial.json
  --include-dirty      probe the working tree (a snapshot commit) instead of HEAD; uncommitted tests count
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
status     --json (exit 0 clean · 1 unproven/stale · 2 nothing to probe yet)
init       --force (replace an existing skill file)  --json
every command accepts --json; probe/baseline emit the status document plus their own result
claims     --json
baseline   --evidence <path>  --out <path>  --allow-provisional (freeze unconfirmed evidence; normally refused)
brief      --evidence <path>  --baseline <path>  --max <n>  --text (print only; safe for hooks)

exit codes: 0 nothing new to prove · 1 unproven claims (or claim drift) · 2 precondition failed · 3 usage
`;

const COMMANDS = { probe: probeCommand, claims: claimsCommand, baseline: baselineCommand, brief: briefCommand, scaffold: scaffoldCommand, status: statusCommand, init: initCommand };

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
        ref: { type: 'string', default: 'HEAD' },
        claim: { type: 'string' },
        'include-dirty': { type: 'boolean', default: false },
        'allow-provisional': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
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
    const projectDir = command === 'scaffold' ? resolve('.') : resolve(dirArg ?? '.');
    return await handler({ projectDir, file: dirArg, values, version: VERSION }, io);
  } catch (e) {
    if (e instanceof ClaimsError || e instanceof PreconditionError || e instanceof GitError || e instanceof SpecDocError) {
      io.err(`error: ${e.message}`);
      return 2;
    }
    throw e;
  }
}
