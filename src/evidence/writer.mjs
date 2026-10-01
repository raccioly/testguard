import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { validate } from '../../spec/lib/validate.mjs';

export class SpecDocError extends Error {}

function describe(kind, path, result) {
  const lines = result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
  return `${kind} document ${path} does not conform to the spec:\n${lines}`;
}

/**
 * Write a spec document — but only if it conforms. The tool is held to its
 * own spec at the moment of output, not by a separate test someone might skip.
 */
export function writeSpecDoc(kind, path, doc, { publish } = {}) {
  const result = validate(kind, doc);
  if (!result.ok) throw new SpecDocError('refusing to write: ' + describe(kind, path, result));
  const output = JSON.stringify(doc, null, 2) + '\n';
  if (publish !== undefined) {
    if (typeof publish !== 'function') throw new TypeError('publish must be a function');
    return publish(output);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, output);
}

/** Read a spec document, refusing one that does not conform. */
export function readSpecDoc(kind, path, { source } = {}) {
  let doc;
  try {
    if (source !== undefined && typeof source !== 'string') throw new Error('source must be a string');
    doc = JSON.parse(source === undefined ? readFileSync(path, 'utf8') : source);
  } catch (e) {
    throw new SpecDocError(`cannot read ${kind} document ${path}: ${e.message}`);
  }
  const result = validate(kind, doc);
  if (!result.ok) throw new SpecDocError(describe(kind, path, result));
  return doc;
}

export const writeEvidence = (path, doc) => writeSpecDoc('evidence', path, doc);
