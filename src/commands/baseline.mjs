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
  const baseline = buildBaseline(evidence);
  const outPath = values.out ? resolve(values.out) : baselinePath(projectDir);
  writeSpecDoc('baseline', outPath, baseline);
  const n = Object.values(baseline.fingerprints).reduce((a, b) => a + b, 0);
  io.out(`baseline: ${n} unproven finding${n === 1 ? '' : 's'} frozen at ${baseline.head.slice(0, 12)} → ${outPath}`);
  io.out('Commit this file. From now on only new findings gate.');
  return 0;
}
