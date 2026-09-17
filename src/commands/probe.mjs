import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadClaims, defaultClaimsPath } from '../claims/load.mjs';
import { probe } from '../probe/probe.mjs';
import { writeSpecDoc, readSpecDoc } from '../evidence/writer.mjs';
import { gate } from '../baseline/baseline.mjs';
import { renderRecord, renderSummary, sortForReport } from '../render.mjs';

export const evidencePath = (projectDir) => join(projectDir, '.testguard', 'evidence.json');
export const baselinePath = (projectDir) => join(projectDir, '.testguard', 'baseline.json');

export async function probeCommand({ projectDir, values, version }, io) {
  const confirmRuns = Number(values.confirm);
  const budgetMs = Number(values.budget);
  if (!Number.isInteger(confirmRuns) || confirmRuns < 1 || !Number.isInteger(budgetMs) || budgetMs < 1000) {
    io.err('--confirm must be a positive integer and --budget at least 1000');
    return 3;
  }
  const claims = loadClaims(values.claims ? resolve(values.claims) : defaultClaimsPath(projectDir));
  if (claims.claims.length === 0) {
    io.err('claims file declares no claims; nothing to verify');
    return 2;
  }
  const outPath = values.out ? resolve(values.out) : evidencePath(projectDir);
  const previous = !values['no-reuse'] && existsSync(outPath) ? readSpecDoc('evidence', outPath) : undefined;
  const basePath = values.baseline ? resolve(values.baseline) : baselinePath(projectDir);
  const baseline = existsSync(basePath) ? readSpecDoc('baseline', basePath) : undefined;

  const evidence = await probe({
    projectDir,
    claims,
    previous,
    confirmRuns,
    budgetMs,
    mode: values['in-place'] ? 'in-place' : 'worktree',
    ref: values.ref,
    escalate: !values['no-escalate'],
    toolVersion: version,
    onProgress: values.quiet ? undefined : (r) => io.out(renderRecord(r) + (r.reusedFrom ? '  (reused)' : '')),
  });
  writeSpecDoc('evidence', outPath, evidence);

  const g = gate(evidence.records, baseline, { severityFloor: values.severity });
  if (!values.quiet) {
    io.out('');
    const tag = (r) => (g.new.includes(r) ? '[NEW]      ' : g.baselined.includes(r) ? '[baseline] ' : '[below floor] ');
    for (const r of sortForReport(evidence.records).filter((x) => x.verdict !== 'killed')) io.out('  ' + tag(r) + renderRecord(r));
  }
  io.out('');
  io.out(renderSummary(evidence.records) + (baseline ? ` ${g.new.length} new since baseline, ${g.baselined.length} baselined.` : ' No baseline.'));
  io.out(`evidence: ${outPath}`);
  return g.new.length > 0 ? 1 : 0;
}
