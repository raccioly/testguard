import { computeStatus, renderStatus } from '../status/status.mjs';
import { validate } from '../../spec/lib/validate.mjs';

export async function statusCommand({ projectDir, values, version }, io) {
  const doc = computeStatus({ projectDir, toolVersion: version, changedRef: values.changed, includeDirty: values['include-dirty'] });
  const result = validate('status', doc);
  if (!result.ok) throw new Error(`status document does not conform: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  io.out(values.json ? JSON.stringify(doc, null, 2) : renderStatus(doc));
  return doc.state === 'clean' ? 0 : doc.state === 'no-claims' || doc.state === 'unprobed' ? 2 : 1;
}
