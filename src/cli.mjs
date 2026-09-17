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

const VERSION = JSON.parse(readFileSync(join(fileURLToPath(import.meta.url), '..', '..', 'package.json'), 'utf8')).version;

const USAGE = `testguard ${VERSION} — proves a test suite defends the claims a project makes

  testguard claims [dir]     list the claims file and report drift against @claim annotations in code
  testguard probe [dir]      inject each claim's faults, run its defenders, report what survived
  testguard baseline [dir]   freeze today's unproven findings so only new ones gate
  testguard brief [dir]      emit the blind-spot block for an agent's session-start context

probe
  --claims <path>      claims file             (default: <dir>/testguard.claims.json)
  --confirm <n>        runs per verdict        (default: 3)
  --budget <ms>        wall clock per run      (default: 120000)
  --out <path>         evidence file           (default: <dir>/.testguard/evidence.json)
  --baseline <path>    baseline to gate against (default: <dir>/.testguard/baseline.json if present)
  --severity <level>   gate only at or above   (default: low)
  --ref <commit>       probe this commit in the scratch worktree (default: HEAD)
  --in-place           mutate the working tree instead of a scratch worktree
  --no-escalate        do not re-run survivors against the whole suite
  --no-reuse           re-probe claims whose inputs have not changed
  --quiet              summary only

claims     --json
baseline   --evidence <path>  --out <path>
brief      --evidence <path>  --baseline <path>  --max <n>  --text (print only; safe for hooks)

exit codes: 0 nothing new to prove · 1 unproven claims (or claim drift) · 2 precondition failed · 3 usage
`;

const COMMANDS = { probe: probeCommand, claims: claimsCommand, baseline: baselineCommand, brief: briefCommand };

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
  if (!['critical', 'high', 'medium', 'low'].includes(values.severity)) {
    io.err('--severity must be one of critical, high, medium, low');
    return 3;
  }
  try {
    return await handler({ projectDir: resolve(dirArg ?? '.'), values, version: VERSION }, io);
  } catch (e) {
    if (e instanceof ClaimsError || e instanceof PreconditionError || e instanceof GitError || e instanceof SpecDocError) {
      io.err(`error: ${e.message}`);
      return 2;
    }
    throw e;
  }
}
