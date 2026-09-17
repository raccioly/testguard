import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readSpecDoc, writeSpecDoc } from '../evidence/writer.mjs';
import { buildBrief } from '../brief/brief.mjs';
import { evidencePath, baselinePath } from './probe.mjs';

export async function briefCommand({ projectDir, values }, io) {
  const evPath = values.evidence ? resolve(values.evidence) : evidencePath(projectDir);
  if (!existsSync(evPath)) {
    // A missing brief must never break an agent's session start.
    if (values.text) return 0;
    io.err(`no evidence at ${evPath}; run \`testguard probe\` first`);
    return 2;
  }
  const evidence = readSpecDoc('evidence', evPath);
  const basePath = values.baseline ? resolve(values.baseline) : baselinePath(projectDir);
  const baseline = existsSync(basePath) ? readSpecDoc('baseline', basePath) : undefined;
  const max = Number(values.max);
  if (!Number.isInteger(max) || max < 1 || max > 50) {
    io.err('--max must be an integer from 1 to 50');
    return 3;
  }
  const brief = buildBrief(evidence, baseline, { max });
  if (!values.text) writeSpecDoc('brief', values.out ? resolve(values.out) : join(projectDir, '.testguard', 'brief.json'), brief);
  io.out(brief.text.trimEnd());
  return 0;
}
