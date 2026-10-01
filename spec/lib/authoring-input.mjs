import { extname } from 'node:path';

const PRIVATE = new Set(['.local', '.wolf', '.git', '.testguard', 'graphify-out']);
const SOURCE = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.py']);

/** Shape validation runs first. These checks cannot authenticate the actual input. */
export function authoringInputErrors(doc) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  const checkPath = (file, path) => {
    if (Buffer.byteLength(file) > 4096 || file.includes('\\') || /[\x00-\x1f\x7f-\x9f]/.test(file) || /^[A-Za-z]:/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..' || PRIVATE.has(part))) fail(path, 'input path must be bounded, canonical and outside private/tooling namespaces');
  };
  if (Buffer.byteLength(JSON.stringify(doc)) > 1024 * 1024) fail('/', 'authoring input report exceeds byte limit');
  const input = doc.input;
  if (input.kind === 'document') {
    checkPath(input.file, '/input/file');
    if (!['.md', '.txt', '.rst', '.adoc'].includes(extname(input.file))) fail('/input/file', 'document format is unsupported');
    return errors;
  }
  if (input.commit.length !== input.parent.length || input.commit === input.parent) fail('/input/parent', 'fix requires a distinct same-width parent identity');
  if (Buffer.byteLength(input.subject) > 1024 || /[\x00-\x1f\x7f-\x9f]/.test(input.subject)) fail('/input/subject', 'commit subject must be bounded untrusted single-line text');
  const { total, supported, deleted, unsupported, excluded } = input.counts;
  if (total !== supported + deleted + unsupported + excluded || input.paths.length !== supported + deleted + unsupported) fail('/input/counts', 'complete path partition must retain excluded/deleted/unsupported denominators');
  const seen = new Set(), actual = { supported: 0, deleted: 0, unsupported: 0 };
  input.paths.forEach((row, i) => {
    const path = `/input/paths/${i}`;
    checkPath(row.file, `${path}/file`);
    if (seen.has(row.file)) fail(`${path}/file`, 'visible path is duplicated');
    seen.add(row.file);
    if (row.oldId.length !== input.commit.length || row.newId.length !== input.commit.length) fail(path, 'path object identities must match commit width');
    const oldZero = /^0+$/.test(row.oldId), newZero = /^0+$/.test(row.newId);
    if ((row.oldMode === '000000') !== oldZero || (row.newMode === '000000') !== newZero ||
      (row.status === 'A' ? !oldZero || newZero : row.status === 'D' ? oldZero || !newZero : oldZero || newZero)) fail(path, 'mode, status and zero identity must agree');
    const disposition = row.status === 'D' ? 'deleted' : !['100644', '100755'].includes(row.newMode) || !SOURCE.has(extname(row.file)) ? 'unsupported' : 'supported';
    if (row.disposition !== disposition) fail(`${path}/disposition`, 'disposition must derive from actual status, mode and supported extension');
    actual[row.disposition]++;
  });
  if (actual.supported !== supported || actual.deleted !== deleted || actual.unsupported !== unsupported) fail('/input/counts', 'visible disposition counts must reproduce every path');
  return errors;
}
