import { extname } from 'node:path';

const PRIVATE = new Set(['.local', '.wolf', '.git', '.testguard', 'graphify-out']);
const SUPPORTED = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.py']);
function refuse(reason) { throw new Error(`fix inventory refused: ${reason}`); }
function safePath(file) {
  if (!file || file.includes('\\') || /[\x00-\x1f\x7f-\x9f]/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(file)) refuse('unsafe-path');
  if (Buffer.byteLength(file) > 4096) refuse('path-byte-limit');
  return file;
}

export function validateFixProjectPrefix(prefix) {
  if (typeof prefix !== 'string') refuse('unsafe-project-prefix');
  if (!prefix) return prefix;
  safePath(prefix);
  if (prefix.split('/').some(part => PRIVATE.has(part))) refuse('excluded-project');
  return prefix;
}

/** Complete historical marker union only; current filesystem admission remains separate. */
export function parseFixProjectMarkers(parentRaw, commitRaw, { projectPrefix = '' } = {}) {
  validateFixProjectPrefix(projectPrefix);
  const projects = new Set();
  for (const raw of [parentRaw, commitRaw]) {
    if (!Buffer.isBuffer(raw)) refuse('buffer-required');
    if (raw.length > 128 * 1024) refuse('output-byte-limit');
    let listing;
    try { listing = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(raw); }
    catch { refuse('invalid-utf8'); }
    if (listing && !listing.endsWith('\0')) refuse('truncated-output');
    const files = listing ? listing.slice(0, -1).split('\0') : [];
    if (files.length > 4096) refuse('tree-name-count-limit');
    const namesSeen = new Set();
    for (const name of files) {
      const file = safePath(name);
      if (namesSeen.has(file)) refuse('duplicate-path');
      namesSeen.add(file);
      if (!file.endsWith('/testguard.claims.json')) continue;
      const project = file.slice(0, -'/testguard.claims.json'.length);
      projects.add(project);
      if (projects.size > 256) refuse('project-count-limit');
    }
  }
  if (projectPrefix) {
    const descendants = [...projects].filter(project => project.startsWith(`${projectPrefix}/`));
    projects.clear();
    for (const project of descendants) projects.add(project.slice(projectPrefix.length + 1));
  }
  return Object.freeze([...projects].filter(project => !project.split('/').some(part => PRIVATE.has(part))).sort());
}

/** Decode complete raw Git data only; supplied exclusions are not discovery authority. */
export function parseFixChangedPaths(raw, { nestedProjects = [], objectIdWidth, projectPrefix = '' } = {}) {
  validateFixProjectPrefix(projectPrefix);
  if (!Buffer.isBuffer(raw)) refuse('buffer-required');
  if (objectIdWidth !== undefined && objectIdWidth !== 40 && objectIdWidth !== 64) refuse('invalid-object-width');
  if (raw.length > 128 * 1024) refuse('output-byte-limit');
  if (!Array.isArray(nestedProjects) || nestedProjects.length > 256) refuse('project-count-limit');
  const projects = nestedProjects.map(safePath);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); }
  catch { refuse('invalid-utf8'); }
  if (text && !text.endsWith('\0')) refuse('truncated-output');
  const parts = text ? text.slice(0, -1).split('\0') : [];
  if (parts.length % 2) refuse('malformed-record');
  if (parts.length / 2 > 256) refuse('path-count-limit');
  const paths = [], seen = new Set();
  const counts = { total: 0, supported: 0, deleted: 0, unsupported: 0, excluded: 0 };
  for (let i = 0; i < parts.length; i += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([AMDT])$/.exec(parts[i]);
    if (!match || match[3].length !== match[4].length) refuse('malformed-record');
    const [, oldMode, newMode, oldId, newId, status] = match;
    if (objectIdWidth !== undefined && oldId.length !== objectIdWidth) refuse('object-width-mismatch');
    const oldZero = /^0+$/.test(oldId), newZero = /^0+$/.test(newId);
    if ((oldMode === '000000') !== oldZero || (newMode === '000000') !== newZero ||
      (status === 'A' ? !oldZero || newZero : status === 'D' ? oldZero || !newZero : oldZero || newZero)) refuse('inconsistent-identity');
    const repositoryFile = safePath(parts[i + 1]);
    if (projectPrefix && !repositoryFile.startsWith(`${projectPrefix}/`)) refuse('out-of-scope-path');
    const file = projectPrefix ? repositoryFile.slice(projectPrefix.length + 1) : repositoryFile;
    if (seen.has(file)) refuse('duplicate-path');
    seen.add(file); counts.total++;
    if (file.split('/').some(part => PRIVATE.has(part)) || projects.some(project => file === project || file.startsWith(`${project}/`))) {
      counts.excluded++; continue;
    }
    const disposition = status === 'D' ? 'deleted' : !['100644', '100755'].includes(newMode) || !SUPPORTED.has(extname(file)) ? 'unsupported' : 'supported';
    counts[disposition]++;
    paths.push(Object.freeze({ file, status, oldMode, newMode, oldId, newId, disposition }));
  }
  return Object.freeze({ paths: Object.freeze(paths), counts: Object.freeze(counts) });
}
