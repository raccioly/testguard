import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from '../../spec/lib/validate.mjs';

export class ClaimsError extends Error {}

export const defaultClaimsPath = (projectDir) => join(projectDir, 'testguard.claims.json');

/** Read and validate a claims file. Any defect is fatal: a claims file is code. */
export function loadClaims(path) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ClaimsError(`cannot read claims file ${path}: ${e.message}`);
  }
  const result = validate('claims', doc);
  if (!result.ok) {
    const lines = result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
    throw new ClaimsError(`claims file ${path} does not conform to the spec:\n${lines}`);
  }
  return doc;
}
