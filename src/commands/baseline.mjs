import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readSpecDoc, writeSpecDoc } from '../evidence/writer.mjs';
import { buildBaseline, restampBaseline } from '../baseline/baseline.mjs';
import { evidencePath, baselinePath } from './probe.mjs';
import { computeStatus } from '../status/status.mjs';
import { isGitIgnored, GITIGNORE_LINES, COMMITTED_OUTPUTS } from '../init/init.mjs';

/**
 * The regenerated outputs this project does not yet ignore.
 *
 * Asked of git rather than of the .gitignore text, so `.testguard/*` with
 * negated exceptions, a global ignore file and .git/info/exclude all answer
 * correctly — which is what stops the advice being repeated every run at a
 * project that is already covered. The list itself comes from init, because
 * keeping a second copy here is precisely how this advice rotted: it named
 * evidence.json and brief.json while the tool had grown to ten outputs.
 */
function unignoredOutputs(projectDir) {
  return GITIGNORE_LINES.filter((l) => !isGitIgnored(projectDir, l.replace('*', 'x')));
}

export async function baselineCommand({ projectDir, values, version }, io) {
  const evPath = values.evidence ? resolve(values.evidence) : evidencePath(projectDir);
  if (!existsSync(evPath)) {
    io.err(`no evidence at ${evPath}; run \`testguard probe\` first`);
    return 2;
  }
  const evidence = readSpecDoc('evidence', evPath);
  if (evidence.run.provisional && !values['allow-provisional']) {
    io.err(`error: ${evPath} is provisional (confirmRuns ${evidence.run.confirmRuns} < 3); a baseline must be frozen from confirmed evidence. Re-run probe with --confirm 3, or pass --allow-provisional if you accept unconfirmed findings as the frozen contract.`);
    return 2;
  }
  const outPath = values.out ? resolve(values.out) : baselinePath(projectDir);
  if (values.restamp) {
    if (!existsSync(outPath)) {
      io.err(`error: no baseline at ${outPath} to re-stamp; run \`testguard baseline\` first`);
      return 2;
    }
    const r = restampBaseline(readSpecDoc('baseline', outPath), evidence);
    if (!r.ok) {
      io.err(`error: cannot re-stamp: ${r.reason}`);
      return 2;
    }
    writeSpecDoc('baseline', outPath, r.baseline);
    io.out(values.json ? JSON.stringify({ ...computeStatus({ projectDir, toolVersion: version }), baseline: { path: outPath, restamped: r.baseline.head } }, null, 2) : `baseline: re-stamped to ${r.baseline.head.slice(0, 12)} (same fingerprints, clean tree) → ${outPath}`);
    return 0;
  }
  const baseline = buildBaseline(evidence);
  writeSpecDoc('baseline', outPath, baseline);
  const n = Object.values(baseline.fingerprints).reduce((a, b) => a + b, 0);
  if (values.json) {
    io.out(JSON.stringify({ ...computeStatus({ projectDir, toolVersion: version }), baseline: { path: outPath, frozen: n } }, null, 2));
    return 0;
  }
  io.out(`baseline: ${n} unproven finding${n === 1 ? '' : 's'} frozen at ${baseline.head.slice(0, 12)}${baseline.snapshot ? ` (working-tree snapshot ${baseline.snapshot.slice(0, 7)}; after you commit, a clean probe + \`baseline --restamp\` moves head to that commit)` : baseline.dirty ? ' (working tree was dirty)' : ''}${evidence.run.provisional ? ' — FROM PROVISIONAL EVIDENCE (--allow-provisional)' : ''} → ${outPath}`);
  io.out('Commit this file; from now on only new findings gate.');
  const missing = unignoredOutputs(projectDir);
  if (missing.length) {
    io.out(`The rest of .testguard/ is regenerated per run; ${missing.length} output${missing.length === 1 ? ' is' : 's are'} not ignored yet. Add to .gitignore:`);
    for (const l of missing) io.out(`  ${l}`);
    io.out(`Or ignore the directory and keep what is committed — the form that needs no update as outputs are added:`);
    io.out('  .testguard/*');
    for (const l of COMMITTED_OUTPUTS) io.out(`  !${l}`);
  }
  return 0;
}
