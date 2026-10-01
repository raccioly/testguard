import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readSpecDoc } from '../evidence/writer.mjs';
import { sha256 } from '../util/hash.mjs';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 32;
const SUPPORTED = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.py']);
const PROTECTED = new Set(['evidence.json', 'evidence-partial.json', 'evidence-provisional.json', 'baseline.json', 'sweep-evidence.json']);

function refuse(reason) { throw new Error(`draft append admission refused: ${reason}`); }
function identity(stat) { return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, mode: stat.mode }; }
function same(stat, expected) { return Object.entries(expected).every(([key, value]) => stat[key] === value); }

function selectedPath(requestedRoot, file) {
  if (typeof file !== 'string' || !file || file.includes('\0') || file.includes('\\') || file.split('/').some((part) => part === '.' || part === '..')) refuse('unsafe-path');
  const rel = relative(requestedRoot, resolve(requestedRoot, file));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) refuse('outside-project');
  return rel.split(sep).join('/');
}

/** Repeat the complete in-checkout path walk; never authorize by existence. */
function inspect(root, file) {
  const base = lstatSync(root);
  if (base.isSymbolicLink() || !base.isDirectory()) refuse('unsafe-root');
  const parts = file.split('/');
  let path = root;
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) refuse('symlink');
    if (i < parts.length - 1) {
      if (!stat.isDirectory()) refuse('not-directory');
      try { lstatSync(join(path, 'testguard.claims.json')); refuse('nested-project'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else {
      if (!stat.isFile() || stat.nlink !== 1) refuse('not-single-regular-file');
      if (stat.size > MAX_FILE_BYTES) refuse('file-byte-limit');
      return { path, stat };
    }
  }
}

function readInput(root, file, admitted) {
  if (constants.O_NOFOLLOW === undefined) refuse('nofollow-unavailable');
  const fd = openSync(admitted.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const expected = identity(admitted.stat);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || !same(before, expected)) refuse('input-changed');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > MAX_FILE_BYTES) refuse('file-byte-limit');
    if (length !== expected.size || !same(fstatSync(fd), expected)) refuse('input-changed');
    const current = inspect(root, file);
    if (!same(current.stat, expected)) refuse('input-changed');
    const bytes = buffer.subarray(0, length);
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { refuse('invalid-utf8'); }
    if (source.includes('\0')) refuse('invalid-encoding');
    return { file, path: admitted.path, source, hash: sha256(bytes), identity: expected };
  } finally { closeSync(fd); }
}

/** Explicit text input only: no statements, claims, provenance promotion or writes. */
export function admitIntentDocument({ projectDir, file }) {
  const requestedRoot = resolve(projectDir);
  if (lstatSync(requestedRoot).isSymbolicLink()) refuse('unsafe-root');
  const root = realpathSync(requestedRoot);
  const name = selectedPath(requestedRoot, file);
  if (name.split('/').some(part => ['.local', '.wolf', '.git', '.testguard', 'graphify-out'].includes(part))) refuse('excluded-document');
  if (!['.md', '.txt', '.rst', '.adoc'].includes(extname(name))) refuse('unsupported-document');
  const input = readInput(root, name, inspect(root, name));
  Object.freeze(input.identity);
  return Object.freeze(input);
}

/** Selected conforming marker only; neither claim contents nor scope authority are returned. */
export function admitIntentProject({ projectDir }) {
  const requestedRoot = resolve(projectDir);
  if (lstatSync(requestedRoot).isSymbolicLink()) refuse('unsafe-root');
  const root = realpathSync(requestedRoot);
  if (root.split(sep).some(part => ['.local', '.wolf', '.git', '.testguard', 'graphify-out'].includes(part))) refuse('excluded-project');
  const file = 'testguard.claims.json';
  const input = readInput(root, file, inspect(root, file));
  readSpecDoc('claims', input.path, { source: input.source });
  const marker = Object.freeze({ file, hash: input.hash, identity: Object.freeze(input.identity) });
  return Object.freeze({ projectDir: root, marker });
}

/** Internal read-only input snapshot. This is not publication authority. */
export function admitDraftAppend({ projectDir, draftPath, files, claimId }) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) refuse('source-count-limit');
  if (typeof claimId !== 'string' || !claimId.trim() || claimId !== claimId.trim() || claimId.includes(',')) refuse('claim-selection');
  const requestedRoot = resolve(projectDir);
  if (lstatSync(requestedRoot).isSymbolicLink()) refuse('unsafe-root');
  const root = realpathSync(requestedRoot);
  const draftFile = selectedPath(requestedRoot, draftPath);
  if (basename(draftFile) === 'testguard.claims.json' || (draftFile.startsWith('.testguard/') && PROTECTED.has(basename(draftFile)))) refuse('protected-destination');
  const names = files.map((file) => selectedPath(requestedRoot, file));
  if (new Set(names).size !== names.length || names.includes(draftFile)) refuse('input-alias');
  if (names.some((file) => !SUPPORTED.has(extname(file)))) refuse('unsupported-source');
  const draftInput = readInput(root, draftFile, inspect(root, draftFile));
  const doc = readSpecDoc('claims', draftInput.path, { source: draftInput.source });
  if (doc.claims.filter((claim) => claim.id === claimId).length !== 1) refuse('unknown-claim');
  const admitted = names.sort().map((file) => ({ file, ...inspect(root, file) }));
  if (admitted.reduce((total, input) => total + input.stat.size, 0) > MAX_SOURCE_BYTES) refuse('source-byte-limit');
  const sources = admitted.map((input) => readInput(root, input.file, input));
  return { projectDir: root, claimId, draft: { ...draftInput, doc }, sources };
}
