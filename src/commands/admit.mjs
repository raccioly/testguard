import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { loadClaims, defaultClaimsPath } from '../claims/load.mjs';
import { probe } from '../probe/probe.mjs';
import { writeSpecDoc } from '../evidence/writer.mjs';
import { resolveDefenders } from '../probe/runners/shared.mjs';
import { discoverDefenders } from '../probe/discover.mjs';
import { PreconditionError } from '../probe/worktree.mjs';
import { hintFor } from '../brief/brief.mjs';
import { formatVerdict, PROVISIONAL_WARNING } from '../render.mjs';
import { decideAdmission } from '../admit/admit.mjs';

/** The project is wherever the claims file is, walking up from the test file; else cwd. */
function findProjectDir(testAbs, claimsFlag) {
  if (claimsFlag) return dirname(resolve(claimsFlag));
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
  if (!file || !values.claim) {
    io.err('usage: testguard admit <test-file> --claim <ID> [--fault <FID>] [--confirm <n>] [--json]');
    return 3;
  }
  const confirmRuns = Number(values.confirm);
  const budgetMs = Number(values.budget);
  if (!Number.isInteger(confirmRuns) || confirmRuns < 1 || !Number.isInteger(budgetMs) || budgetMs < 1000) {
    io.err('--confirm must be a positive integer and --budget at least 1000');
    return 3;
  }
  const testAbs = resolve(file);
  if (!existsSync(testAbs)) throw new PreconditionError(`no such file: ${file}`);
  const projectDir = findProjectDir(testAbs, values.claims);
  const testRel = relative(projectDir, testAbs);
  if (testRel.startsWith('..')) throw new PreconditionError(`${file} is outside the project directory ${projectDir}`);

  const all = loadClaims(values.claims ? resolve(values.claims) : defaultClaimsPath(projectDir));
  const claimId = values.claim.trim();
  const claim = all.claims.find((c) => c.id === claimId);
  if (!claim) throw new PreconditionError(`--claim: unknown claim id ${claimId}`);
  const faults = values.fault ? claim.faults.filter((f) => f.id === values.fault) : claim.faults;
  if (faults.length === 0) throw new PreconditionError(`--fault: ${claimId} has no fault ${values.fault}`);

  // The named test must be a defender of the claim, declared or discovered;
  // otherwise `killed` below would be someone else's test doing the work.
  const declared = claim.defendedBy?.length ? resolveDefenders(projectDir, claim.defendedBy) : null;
  const isDefender = declared ? declared.includes(testRel) : faults.some((f) => discoverDefenders(projectDir, f.file).includes(testRel));
  if (!isDefender) {
    io.err(declared
      ? `${testRel} is not a defender of ${claimId}. Add it: "defendedBy": [${[...claim.defendedBy, testRel].map((d) => JSON.stringify(d)).join(', ')}] in testguard.claims.json, then run admit again.`
      : `${testRel} does not import ${[...new Set(faults.map((f) => f.file))].join(' or ')}, so it cannot be discovered as a defender of ${claimId}. Import the module under test, or declare "defendedBy": ["${testRel}"] on the claim.`);
    return 3;
  }

  const provisional = confirmRuns < 3;
  if (provisional && !values.quiet) io.err(PROVISIONAL_WARNING(confirmRuns));
  const command = `testguard probe --claim ${claimId} --include-dirty --confirm ${confirmRuns} --no-escalate`;
  const evidence = await probe({
    projectDir,
    claims: { ...all, claims: [{ ...claim, faults }] },
    confirmRuns,
    budgetMs,
    mode: 'worktree',
    includeDirty: true,
    only: [claimId],
    escalate: false,
    runnerCommand: values['runner-cmd'],
    runnerName: values.runner,
    nodeModules: values['node-modules'] ? resolve(values['node-modules']) : process.env.TESTGUARD_NODE_MODULES,
    toolVersion: version,
    onStage: !values.quiet && !values.json && process.stderr.isTTY ? ({ claimId: c, faultId, stage, i, n }) => process.stderr.write(`\r\x1b[K  … ${c}/${faultId} ${stage} ${i}/${n}`) : undefined,
  });
  if (process.stderr.isTTY && !values.quiet && !values.json) process.stderr.write('\r\x1b[K');
  const outPath = values.out ? resolve(values.out) : join(projectDir, '.testguard', 'evidence-partial.json');
  writeSpecDoc('evidence', outPath, evidence);

  const decision = decideAdmission(evidence.records);
  const result = {
    admitted: decision.admitted,
    provisional,
    claim: claimId,
    test: testRel,
    faults: evidence.records.map((r) => ({ id: r.subject.id, verdict: r.verdict, ...(r.detail.reason ? { reason: r.detail.reason } : {}), hint: hintFor(r) })),
    evidence: outPath,
    command,
  };
  if (values.json) {
    io.out(JSON.stringify(result, null, 2));
  } else {
    for (const r of evidence.records) io.out(`  ${formatVerdict(r.verdict, provisional).padEnd(15)} ${claimId}/${r.subject.id}  ${r.subject.description}${r.detail.reason ? `  [${r.detail.reason}]` : ''}`);
    io.out('');
    if (decision.admitted) {
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
  return decision.admitted ? 0 : 1;
}
