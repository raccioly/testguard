import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { validate } from '../../spec/lib/validate.mjs';
import { sha256 } from '../util/hash.mjs';

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

/**
 * What a measurement records about a claims file that lives outside the
 * project under probe: that it was external, and its hash, never its path. The
 * path is the caller's business and often a private one; the hash is enough to
 * say which file a record was measured against. `undefined` for the project's
 * own claims, which the repository already names.
 */
export function claimsSourceOf(projectDir, claimsPath) {
  const root = realpathSync(resolve(projectDir));
  const abs = realpathSync(resolve(claimsPath));
  const rel = relative(root, abs);
  if (rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) return undefined;
  return { external: true, sha256: sha256(readFileSync(abs)) };
}
