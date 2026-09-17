import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readSpecDoc, writeSpecDoc } from '../evidence/writer.mjs';
import { buildBaseline } from '../baseline/baseline.mjs';
import { evidencePath, baselinePath } from './probe.mjs';

export async function baselineCommand({ projectDir, values }, io) {
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
  const baseline = buildBaseline(evidence);
  const outPath = values.out ? resolve(values.out) : baselinePath(projectDir);
  writeSpecDoc('baseline', outPath, baseline);
  const n = Object.values(baseline.fingerprints).reduce((a, b) => a + b, 0);
  io.out(`baseline: ${n} unproven finding${n === 1 ? '' : 's'} frozen at ${baseline.head.slice(0, 12)}${baseline.dirty ? ' (working tree was dirty)' : ''}${evidence.run.provisional ? ' — FROM PROVISIONAL EVIDENCE (--allow-provisional)' : ''} → ${outPath}`);
  io.out('Commit this file; from now on only new findings gate. Ignore the regenerated ones — add to .gitignore:');
  io.out('  .testguard/evidence.json');
  io.out('  .testguard/brief.json');
  return 0;
}
