import { join, resolve } from 'node:path';
import { computeStatus, renderStatus } from '../status/status.mjs';
import { validate } from '../../spec/lib/validate.mjs';
import { resolveChangedRef, withChangedRef } from '../gate/changed.mjs';
import { configReport } from '../config/project-config.mjs';

/** `--claims` moves only the claims file; evidence, provisional evidence and baseline stay the project's own. */
export const statusPaths = (projectDir, claims) => ({
  claims: resolve(claims),
  evidence: join(projectDir, '.testguard', 'evidence.json'),
  provisional: join(projectDir, '.testguard', 'evidence-provisional.json'),
  baseline: join(projectDir, '.testguard', 'baseline.json'),
});

export async function statusCommand({ projectDir, values, version, projectConfig }, io) {
  const evidence = values.evidence ? resolve(values.evidence) : undefined;
  const doc = withChangedRef(resolveChangedRef({ explicit: values.changed, projectDir }), (changedRef) => computeStatus({ projectDir, toolVersion: version, changedRef, includeDirty: values['include-dirty'], evidence, adviseChange: values.changed !== undefined, ...(values.claims ? { paths: statusPaths(projectDir, values.claims) } : {}) }), io.err);
  if (projectConfig) doc.config = configReport(projectConfig);
  const result = validate('status', doc);
  if (!result.ok) throw new Error(`status document does not conform: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  io.out(values.json ? JSON.stringify(doc, null, 2) : renderStatus(doc));
  return doc.state === 'clean' ? 0 : doc.state === 'no-claims' || doc.state === 'unprobed' ? 2 : 1;
}
