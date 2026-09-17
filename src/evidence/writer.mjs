import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { validate } from '../../spec/lib/validate.mjs';

/**
 * Write an evidence file — but only if it conforms. The tool is held to its
 * own spec at the moment of output, not by a separate test someone might skip.
 */
export function writeEvidence(path, doc) {
  const result = validate('evidence', doc);
  if (!result.ok) {
    const lines = result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
    throw new Error(`refusing to write non-conforming evidence:\n${lines}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
}
