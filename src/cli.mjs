import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClaims, defaultClaimsPath, ClaimsError } from './claims/load.mjs';
import { probe } from './probe/probe.mjs';
import { PreconditionError } from './probe/worktree.mjs';
import { GitError } from './git.mjs';
import { writeEvidence } from './evidence/writer.mjs';
import { renderRecord, renderSummary, sortForReport } from './render.mjs';

const VERSION = JSON.parse(readFileSync(join(fileURLToPath(import.meta.url), '..', '..', 'package.json'), 'utf8')).version;

const USAGE = `testguard ${VERSION}

  testguard probe [dir]      inject each claim's faults, run its defenders, report what survived
  testguard claims [dir]     (v0.1 phase D)
  testguard baseline [dir]   (v0.1 phase D)
  testguard brief [dir]      (v0.1 phase D)

probe options
  --claims <path>     claims file          (default: <dir>/testguard.claims.json)
  --confirm <n>       runs per verdict     (default: 3)
  --budget <ms>       wall clock per run   (default: 120000)
  --out <path>        evidence file        (default: <dir>/.testguard/evidence.json)
  --in-place          mutate the working tree instead of a scratch worktree
  --no-escalate       do not re-run survivors against the whole suite
  --quiet             summary only

exit codes: 0 nothing unproven · 1 unproven claims · 2 precondition failed · 3 usage
`;

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
        'in-place': { type: 'boolean', default: false },
        'no-escalate': { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
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
  if (command !== 'probe') {
    io.err(command === 'claims' || command === 'baseline' || command === 'brief' ? `${command}: not yet implemented` : `unknown command: ${command}`);
    return 3;
  }

  const projectDir = resolve(dirArg ?? '.');
  const confirmRuns = Number(values.confirm);
  const budgetMs = Number(values.budget);
  if (!Number.isInteger(confirmRuns) || confirmRuns < 1 || !Number.isInteger(budgetMs) || budgetMs < 1000) {
    io.err('--confirm must be a positive integer and --budget at least 1000');
    return 3;
  }

  try {
    const claims = loadClaims(values.claims ? resolve(values.claims) : defaultClaimsPath(projectDir));
    if (claims.claims.length === 0) {
      io.err('claims file declares no claims; nothing to verify');
      return 2;
    }
    const evidence = await probe({
      projectDir,
      claims,
      confirmRuns,
      budgetMs,
      mode: values['in-place'] ? 'in-place' : 'worktree',
      escalate: !values['no-escalate'],
      toolVersion: VERSION,
      onProgress: values.quiet ? undefined : (r) => io.out(renderRecord(r)),
    });
    const outPath = values.out ? resolve(values.out) : join(projectDir, '.testguard', 'evidence.json');
    writeEvidence(outPath, evidence);
    if (!values.quiet) {
      io.out('');
      for (const r of sortForReport(evidence.records).filter((x) => x.verdict !== 'killed')) io.out('  ' + renderRecord(r));
    }
    io.out('');
    io.out(renderSummary(evidence.records));
    io.out(`evidence: ${outPath}`);
    return evidence.records.some((r) => r.verdict !== 'killed') ? 1 : 0;
  } catch (e) {
    if (e instanceof ClaimsError || e instanceof PreconditionError || e instanceof GitError) {
      io.err(`error: ${e.message}`);
      return 2;
    }
    throw e;
  }
}
