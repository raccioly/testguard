import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readSpecDoc, writeSpecDoc } from '../evidence/writer.mjs';
import { buildBrief, buildUnclaimedBrief, renderBriefMarkdown, renderUnclaimedMarkdown } from '../brief/brief.mjs';
import { computeStatus } from '../status/status.mjs';
import { evidencePath, baselinePath } from './probe.mjs';
import { resolveChangedRef, withChangedRef } from '../gate/changed.mjs';

export async function briefCommand({ projectDir, values, version }, io) {
  const evPath = values.evidence ? resolve(values.evidence) : evidencePath(projectDir);
  let status;
  try {
    // A detected base that does not resolve is silent here: the brief is a
    // session-start hook's output and must never add noise; `status` and
    // `gate` are where that warning is printed.
    status = withChangedRef(resolveChangedRef({ explicit: values.changed, projectDir }), (changedRef) => computeStatus({ projectDir, toolVersion: version, changedRef, includeDirty: values['include-dirty'], evidence: values.evidence ? evPath : undefined }));
  } catch {
    status = undefined; // a brief must never fail because status could not be computed
  }
  if (!existsSync(evPath)) {
    // A missing brief must never break an agent's session start — but unclaimed
    // changes are still said, because the claim comes before the probe.
    if (values.text || values.markdown) {
      if (status?.changes?.uncovered?.length) {
        const args = { tool: { name: 'testguard', version }, next: status.next, changes: status.changes };
        io.out((values.markdown ? renderUnclaimedMarkdown(args) : buildUnclaimedBrief(args).text).trimEnd());
      }
      return 0;
    }
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
  // Where this binary came from, so a stale install is visible in the session-start context.
  const install = /[\\/]node_modules[\\/]/.test(process.argv[1] ?? '') ? 'local install' : 'global';
  const brief = buildBrief(evidence, baseline, { max, next: status?.next, changes: status?.changes, install });
  if (!values.text && !values.markdown) writeSpecDoc('brief', values.out ? resolve(values.out) : join(projectDir, '.testguard', 'brief.json'), brief);
  if (values.markdown) io.out(renderBriefMarkdown({ ...brief, provisional: Boolean(evidence.run.provisional) }, { hasBaseline: Boolean(baseline), total: evidence.records.length, install }).trimEnd());
  else io.out(values.json ? JSON.stringify(brief, null, 2) : brief.text.trimEnd());
  return 0;
}
