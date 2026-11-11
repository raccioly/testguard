import { createCommandBudget, parseCommandBudget } from '../command-budget.mjs';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { repoRoot } from '../git.mjs';
import { loadClaims, defaultClaimsPath, claimsSourceOf } from '../claims/load.mjs';
import { probe } from '../probe/probe.mjs';
import { writeSpecDoc } from '../evidence/writer.mjs';
import { resolveDefenders } from '../probe/runners/shared.mjs';
import { discoverDefenders } from '../probe/discover.mjs';
import { defenderSelection } from '../probe/attribution.mjs';
import { PreconditionError } from '../probe/worktree.mjs';
import { hintFor } from '../brief/brief.mjs';
import { formatVerdict, PROVISIONAL_WARNING } from '../render.mjs';
import { decideAdmission } from '../admit/admit.mjs';
import { runnerOptions } from './runner-options.mjs';
import { assertionPolicyRequest, evaluateAssertionPolicy, renderAssertionPolicy } from '../probe/assertion-policy.mjs';

/** The project is wherever the claims file is, walking up from the test file; else cwd. */
function findProjectDir(testAbs, claimsFlag) {
  if (claimsFlag) {
    const dir = realpathSync(dirname(resolve(claimsFlag)));
    const rel = relative(dir, testAbs);
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return dir;
    // A claims file kept outside the project says nothing about where the
    // project is: fault and defender paths are relative to the repository the
    // test lives in.
    try { return repoRoot(dirname(testAbs)); } catch { return resolve('.'); }
  }
  let dir = dirname(testAbs);
  for (let hop = 0; hop < 20; hop++) {
    if (existsSync(defaultClaimsPath(dir))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve('.');
}

/**
 * `testguard admit <test-file> --claim <ID>`: the two-gate rule as one verb.
 * Sugar over `probe --claim <ID> --include-dirty`; no second engine, so the
 * decision here can never disagree with the gate.
 */
export async function admitCommand({ file, values, version }, io) {
  if (!file || !values.claim?.length) {
    io.err('usage: testguard admit <test-file> --claim <ID> [--fault <FID>] [--confirm <n>] [--json]');
    return 3;
  }
  if (values.claim.length > 1 || values.claim[0].includes(',')) {
    io.err('admit accepts exactly one --claim <ID>');
    return 3;
  }
  const claimId = values.claim[0].trim();
  if (!claimId) {
    io.err('--claim must name one claim id');
    return 3;
  }
  const runner = runnerOptions(values);
  if (runner.error) {
    io.err(runner.error);
    return 3;
  }
  const requireAssertionKill = assertionPolicyRequest(values, 'admit');
  const confirmRuns = Number(values.confirm);
  const budgetMs = Number(values.budget);
  const commandBudgetMs = parseCommandBudget(values['command-budget']);
  if (commandBudgetMs === null) { io.err('--command-budget must be at least 1000 milliseconds'); return 3; }
  const commandBudget = createCommandBudget(commandBudgetMs);
  const workers = Number(values.workers ?? 1);
  if (!Number.isSafeInteger(workers) || workers < 1) {
    io.err('--workers must be a positive safe integer');
    return 3;
  }
  if (!Number.isInteger(confirmRuns) || confirmRuns < 1 || !Number.isInteger(budgetMs) || budgetMs < 1000) {
    io.err('--confirm must be a positive integer and --budget at least 1000');
    return 3;
  }
  if (!existsSync(resolve(file))) throw new PreconditionError(`no such file: ${file}`);
  // The repository root git reports is a real path; compare like with like.
  const testAbs = realpathSync(resolve(file));
  const projectDir = findProjectDir(testAbs, values.claims);
  const testRel = relative(projectDir, testAbs);
  if (testRel.startsWith('..')) throw new PreconditionError(`${file} is outside the project directory ${projectDir}`);

  const claimsPath = values.claims ? resolve(values.claims) : defaultClaimsPath(projectDir);
  const all = loadClaims(claimsPath);
  const claimsSource = claimsSourceOf(projectDir, claimsPath);
  const claim = all.claims.find((c) => c.id === claimId);
  if (!claim) throw new PreconditionError(`--claim: unknown claim id ${claimId}`);
  const faults = values.fault ? claim.faults.filter((f) => f.id === values.fault) : claim.faults;
  if (faults.length === 0) throw new PreconditionError(`--fault: ${claimId} has no fault ${values.fault}`);

  // The named test must be a defender of the claim, declared or discovered;
  // otherwise `killed` below would be someone else's test doing the work.
  const selections = faults.map((f) => {
    const { requested } = defenderSelection(claim, f);
    return { requested, resolved: requested.length ? resolveDefenders(projectDir, requested) : discoverDefenders(projectDir, f.file) };
  });
  const declared = selections.every((s) => s.requested.length) ? selections[0].requested : null;
  const isDefender = selections.some((s) => s.resolved.includes(testRel));
  if (!isDefender) {
    io.err(declared
      ? `${testRel} is not a defender of ${claimId}. Add it: "defendedBy": [${[...declared, testRel].map((d) => JSON.stringify(d)).join(', ')}] on the selected fault or its inherited claim in testguard.claims.json, then run admit again.`
      : `${testRel} does not import ${[...new Set(faults.map((f) => f.file))].join(' or ')}, so it cannot be discovered as a defender of ${claimId}. Import the module under test, or declare "defendedBy": ["${testRel}"] on the claim.`);
    return 3;
  }

  const provisional = confirmRuns < 3;
  if (provisional && !values.quiet) io.err(PROVISIONAL_WARNING(confirmRuns));
  const command = `testguard probe --claim ${claimId} --include-dirty --confirm ${confirmRuns} --no-escalate${claimsSource ? ' --claims <claims-file>' : ''}`;
  const evidence = await probe({
    projectDir,
    claims: { ...all, claims: [{ ...claim, faults }] },
    confirmRuns,
    budgetMs,
    commandBudget,
    workers,
    serial: values.serial || workers === 1,
    mode: 'worktree',
    includeDirty: true,
    only: [claimId],
    escalate: false,
    runnerCommand: runner.runnerCommand,
    runnerName: values.runner,
    nodeModules: values['node-modules'] ? resolve(values['node-modules']) : process.env.TESTGUARD_NODE_MODULES,
    python: runner.python,
    toolVersion: version,
    onStage: !values.quiet && !values.json && process.stderr.isTTY ? ({ claimId: c, faultId, stage, i, n }) => process.stderr.write(`\r\x1b[K  … ${c}/${faultId} ${stage} ${i}/${n}`) : undefined,
  });
  if (process.stderr.isTTY && !values.quiet && !values.json) process.stderr.write('\r\x1b[K');
  const outPath = values.out ? resolve(values.out) : join(projectDir, '.testguard', 'evidence-partial.json');
  commandBudget?.assertOpen();
  if (claimsSource) evidence.run.claimsSource = claimsSource;
  // The test kills every fault; the policy asks whether any assertion did the killing.
  const policy = requireAssertionKill ? evaluateAssertionPolicy(evidence.records) : undefined;
  if (policy) evidence.assertionPolicy = policy;
  writeSpecDoc('evidence', outPath, evidence);

  const decision = decideAdmission(evidence.records);
  const admitted = decision.admitted && policy?.state !== 'failed';
  const result = {
    admitted,
    ...(policy ? { assertionPolicy: policy } : {}),
    provisional,
    claim: claimId,
    test: testRel,
    faults: evidence.records.map((r) => ({ id: r.subject.id, verdict: r.verdict, ...(r.detail.killKind ? { killKind: r.detail.killKind } : {}), ...(r.detail.reason ? { reason: r.detail.reason } : {}), hint: hintFor(r) })),
    evidence: outPath,
    command,
  };
  if (values.json) {
    io.out(JSON.stringify(result, null, 2));
  } else {
    for (const r of evidence.records) io.out(`  ${formatVerdict(r.verdict, provisional).padEnd(15)} ${claimId}/${r.subject.id}  ${r.subject.description}${r.detail.reason ? `  [${r.detail.reason}]` : ''}${r.detail.killKind === 'exception-only' ? '  [killed by exception only: no assertion failed]' : ''}`);
    io.out('');
    if (decision.admitted && !admitted) {
      io.out(`NOT ADMITTED: ${testRel} kills every fault of ${claimId}, but ${renderAssertionPolicy(policy)}`);
    } else if (decision.admitted) {
      io.out(provisional
        ? `ADMITTED? — ${testRel} kills ${evidence.records.length === 1 ? 'the fault' : `all ${evidence.records.length} faults`} of ${claimId} at --confirm ${confirmRuns}. Provisional: confirm with --confirm 3 before committing.`
        : `ADMITTED — ${testRel} passes on HEAD and fails on ${evidence.records.length === 1 ? 'the fault' : `all ${evidence.records.length} faults`} of ${claimId}, ${confirmRuns}/${confirmRuns}. Commit it.`);
    } else {
      const b = decision.blocking;
      io.out(`NOT ADMITTED: ${b.verdict}${b.detail.reason ? ` (${b.detail.reason})` : ''} on ${claimId}/${b.subject.id}`);
      io.out(`  ${hintFor(b)}`);
    }
    io.out(`evidence: ${outPath} (partial; not the canonical evidence file)`);
  }
  if (provisional && !values.quiet && !values.json) io.err(PROVISIONAL_WARNING(confirmRuns));
  return admitted ? 0 : 1;
}
