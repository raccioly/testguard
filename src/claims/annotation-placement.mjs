import { constants, chmodSync, closeSync, fsyncSync, fstatSync, ftruncateSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { validate } from '../../spec/lib/validate.mjs';
import { locate } from '../probe/inject.mjs';
import { sha256 } from '../util/hash.mjs';

const SUPPORTED = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.py']);
const SKIP = new Set(['node_modules', 'dist', 'coverage', 'test', 'tests', '__tests__']);
const CLAIM_ID = /^[A-Za-z0-9]+(?:[._][A-Za-z0-9]+)*-[A-Za-z0-9._-]*[A-Za-z0-9]$/;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PLAN_BYTES = 16 * 1024 * 1024;

function canonicalRoot(projectDir) {
  const requested = resolve(projectDir);
  try {
    // Keep a directly symlinked root for admission to refuse; parent aliases
    // are resolved once so plans bind the actual explicitly selected root.
    if (lstatSync(requested).isSymbolicLink()) return requested;
    return realpathSync(requested);
  } catch { return requested; }
}

function containedRelative(file) {
  return file !== '..' && !file.startsWith(`..${sep}`) && !isAbsolute(file);
}

function selectedClaimsPath(root, projectDir, claimsPath) {
  const fromSelected = relative(resolve(projectDir), resolve(claimsPath));
  return containedRelative(fromSelected) ? resolve(root, fromSelected) : resolve(claimsPath);
}

export function recoveryBase(root) {
  const base = realpathSync(tmpdir());
  if (containedRelative(relative(root, base))) throw new Error('recovery directory must be outside the project');
  return base;
}

/** Admission precedes reads: do not follow even an ancestor symlink. */
function admittedPath(root, file, { source = true } = {}) {
  const parts = file.split('/');
  if (file.includes('\\') || parts.some((p) => !p || p === '.' || p === '..') || resolve(root, file) !== join(root, ...parts)) return { reason: 'unsafe-path' };
  if (source && (parts.some((p) => p.startsWith('.') || SKIP.has(p)) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file))) return { reason: 'excluded-target' };
  if (source && !SUPPORTED.has(extname(file))) return { reason: 'unsupported-source' };
  let path = root;
  try {
    const base = lstatSync(root);
    if (base.isSymbolicLink() || !base.isDirectory()) return { reason: 'symlink-target' };
    for (let i = 0; i < parts.length; i++) {
      path = join(path, parts[i]);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return { reason: 'symlink-target' };
      if (i < parts.length - 1) {
        if (!stat.isDirectory()) return { reason: 'not-regular-file' };
        try { lstatSync(join(path, 'testguard.claims.json')); return { reason: 'nested-project' }; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      } else {
        if (!stat.isFile() || stat.nlink !== 1) return { reason: 'not-regular-file' };
        if (stat.size > MAX_BYTES) return { reason: 'source-too-large' };
        return { path, stat };
      }
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { reason: 'target-missing' };
    return { reason: 'target-unreadable' };
  }
}

function readSource(path, expected) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return readDescriptor(fd, expected); }
  finally { closeSync(fd); }
}

function readDescriptor(fd, expected) {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size !== expected.size || stat.mtimeMs !== expected.mtimeMs) return { reason: 'target-changed' };
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    const after = fstatSync(fd);
    if (bytes.length > MAX_BYTES || bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return { reason: 'target-changed' };
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return { reason: 'invalid-encoding' }; }
    if (source.includes('\0')) return { reason: 'invalid-encoding' };
    const bare = source.replaceAll('\r\n', '');
    if (bare.includes('\r') || (source.includes('\r\n') && bare.includes('\n'))) return { reason: 'mixed-newlines' };
    return { source, sourceHash: sha256(bytes), newline: source.includes('\r\n') ? '\r\n' : '\n', identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode } };
}

/** Only leading line-comment headers are witnesses, never quoted code text. */
function hasAnnotation(source, id, python) {
  for (const line of source.split(/\r?\n/)) {
    const text = line.replace(/^\uFEFF/, '').trimStart();
    if (!text || text.startsWith('#!')) continue;
    if (!text.startsWith(python ? '#' : '//')) break;
    if ([...text.matchAll(/@claim\s+([^\s]+)/g)].some((match) => match[1] === id)) return true;
  }
  return false;
}

function header(source, ids, python, newline) {
  let offset = source.startsWith('\uFEFF') ? 1 : 0;
  const lines = source.slice(offset).split(newline);
  let protectedLines = lines[0].startsWith('#!') ? 1 : 0;
  if (python) {
    for (let i = 0; i < Math.min(2, lines.length); i++) {
      if (/^\s*#.*coding\s*[:=]\s*[-\w.]+/.test(lines[i])) protectedLines = i + 1;
    }
  }
  for (let i = 0; i < protectedLines; i++) offset += lines[i].length + (i < lines.length - 1 ? newline.length : 0);
  const prefix = source.slice(0, offset);
  const separator = protectedLines && !prefix.endsWith(newline) ? newline : '';
  return prefix + separator + ids.map((id) => `${python ? '#' : '//'} @claim ${id}${newline}`).join('') + source.slice(offset);
}

/** Internal read-only plan. Not an evidence document or a successful apply. */
export function planAnnotationPlacement({ projectDir, claims, claimIds = [] }) {
  if (!validate('claims', claims).ok) throw new Error('claims must conform before annotation placement');
  if (!Array.isArray(claimIds) || claimIds.some((id) => typeof id !== 'string')) throw new Error('claim selection must be an array of IDs');
  const selected = new Set(claimIds);
  for (const id of selected) if (!claims.claims.some((c) => c.id === id)) throw new Error(`unknown claim ${id}`);
  const root = canonicalRoot(projectDir);
  const targets = new Map();
  const selectedClaims = claims.claims.filter((c) => !selected.size || selected.has(c.id));
  for (const claim of selectedClaims) {
    for (const fault of claim.faults) {
      const file = fault.file ?? `(claim ${claim.id} without a target)`;
      if (!targets.has(file)) targets.set(file, []);
      targets.get(file).push({ claim, fault });
    }
  }
  const files = [], refused = [];
  let admittedBytes = 0;
  for (const [file, entries] of [...targets].sort(([a], [b]) => a.localeCompare(b))) {
    const ids = [...new Set(entries.map(({ claim }) => claim.id))].sort();
    const refuse = (reason) => refused.push({ file, claimIds: ids, reason });
    if (ids.some((id) => !CLAIM_ID.test(id))) { refuse('unsupported-claim-id'); continue; }
    if (entries.some(({ fault }) => (fault.method ?? 'fault-injection') !== 'fault-injection')) { refuse('unsupported-method'); continue; }
    const target = admittedPath(root, file);
    if (target.reason) { refuse(target.reason); continue; }
    if (admittedBytes + target.stat.size > MAX_PLAN_BYTES) { refuse('plan-source-budget'); continue; }
    admittedBytes += target.stat.size;
    let input;
    try { input = readSource(target.path, target.stat); }
    catch { refuse('target-unreadable'); continue; }
    if (input.reason) { refuse(input.reason); continue; }
    const invalid = entries.map(({ fault }) => locate(input.source, fault)).find((anchor) => anchor.status !== 'ok');
    if (invalid) { refuse(invalid.status); continue; }
    const python = extname(file) === '.py';
    const missing = ids.filter((id) => !hasAnnotation(input.source, id, python));
    const proposed = missing.length ? header(input.source, missing, python, input.newline) : input.source;
    const proposedBytes = Buffer.byteLength(proposed, 'utf8');
    if (proposedBytes > MAX_BYTES) { refuse('proposed-source-too-large'); continue; }
    const growth = Math.max(0, proposedBytes - target.stat.size);
    if (admittedBytes + growth > MAX_PLAN_BYTES) { refuse('plan-source-budget'); continue; }
    admittedBytes += growth;
    files.push({ file, claimIds: ids, sourceHash: input.sourceHash, identity: input.identity, source: input.source, proposed, changed: proposed !== input.source });
  }
  return { projectDir: root, selectedClaimIds: selectedClaims.map((c) => c.id).sort(), claimsHash: sha256(JSON.stringify(claims)), files, refused, applicable: refused.length === 0 };
}

/** Recompute before authoring. Never trust a saved proposal or hash alone. */
export function revalidateAnnotationPlan({ projectDir, claims, plan }) {
  if (!plan || plan.projectDir !== canonicalRoot(projectDir) || !Array.isArray(plan.selectedClaimIds)) return { current: false, reason: 'plan-invalid' };
  if (!validate('claims', claims).ok || plan.claimsHash !== sha256(JSON.stringify(claims))) return { current: false, reason: 'claims-changed' };
  let fresh;
  try { fresh = planAnnotationPlacement({ projectDir, claims, claimIds: plan.selectedClaimIds }); }
  catch { return { current: false, reason: 'plan-invalid' }; }
  if (!fresh.applicable) return { current: false, reason: 'plan-refused' };
  if (!isDeepStrictEqual(plan, fresh)) return { current: false, reason: 'plan-changed' };
  return { current: true, plan: fresh };
}

/** Bounded preview input; an external claims file never authorizes an apply. */
export function loadAnnotationClaims(claimsPath) {
  const selectedRoot = dirname(resolve(claimsPath));
  const root = canonicalRoot(selectedRoot);
  return currentClaims(root, selectedClaimsPath(root, selectedRoot, claimsPath));
}

function currentClaims(root, claimsPath) {
  const file = relative(root, resolve(claimsPath)).split(sep).join('/');
  const target = admittedPath(root, file, { source: false });
  if (target.reason) throw new Error(`claims path refused: ${target.reason}`);
  const input = readSource(target.path, target.stat);
  if (input.reason) throw new Error(`claims read refused: ${input.reason}`);
  try { return JSON.parse(input.source); }
  catch { throw new Error('claims file contains invalid JSON'); }
}

/** Exclusive creation and byte ownership: never reclaim a possibly live lock. */
export function authoringLock(root) {
  const path = join(root, '.testguard-annotations.lock');
  let fd;
  try { fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('annotation authoring lock already exists'); throw error; }
  const identity = fstatSync(fd);
  const content = Buffer.from(JSON.stringify({ pid: process.pid, token: randomUUID() }));
  let result;
  const assertOwned = () => {
    if (result) throw new Error('annotation authoring lock released');
    const current = lstatSync(path);
    const bytes = Buffer.alloc(content.length + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (current.isSymbolicLink() || current.nlink !== 1 || current.dev !== identity.dev || current.ino !== identity.ino || count !== content.length || !bytes.subarray(0, count).equals(content)) throw new Error('annotation authoring lock changed');
  };
  const release = () => {
    if (result) return result;
    try {
      const current = lstatSync(path);
      const bytes = Buffer.alloc(content.length + 1);
      const count = readSync(fd, bytes, 0, bytes.length, 0);
      if (current.isSymbolicLink() || current.nlink !== 1 || current.dev !== identity.dev || current.ino !== identity.ino || count !== content.length || !bytes.subarray(0, count).equals(content)) {
        result = { released: false, reason: 'lock-changed' };
      } else { unlinkSync(path); result = { released: true }; }
    } catch (error) { result = { released: false, reason: error.code === 'ENOENT' ? 'lock-changed' : 'lock-release-failed' }; }
    finally { closeSync(fd); }
    return result;
  };
  try { writeFileSync(fd, content); }
  catch (error) {
    // No other actor may use this exclusively-created file yet. Still verify
    // inode ownership rather than unlinking an arbitrary replacement.
    try {
      const current = lstatSync(path);
      if (!current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path);
    } finally { closeSync(fd); }
    throw error;
  }
  return { release, assertOwned };
}

export function persistRecovery(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
}

/** Only fresh internal plan containers enter this boundary, never caller objects. */
function freezePrepared(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezePrepared(child);
    Object.freeze(value);
  }
  return value;
}

/** Prepare recoverable authoring. This function never rewrites source files. */
export function prepareAnnotationApply({ projectDir, claimsPath, plan }) {
  const root = canonicalRoot(projectDir);
  const claimsFile = selectedClaimsPath(root, projectDir, claimsPath);
  // Establish safe claims/root admission before creating even a lock.
  currentClaims(root, claimsFile);
  const lock = authoringLock(root);
  let recoveryDir;
  try {
    const claims = currentClaims(root, claimsFile);
    const checked = revalidateAnnotationPlan({ projectDir: root, claims, plan });
    if (!checked.current) throw new Error(`annotation preview refused: ${checked.reason}`);
    if (checked.plan.files.some((file) => resolve(root, file.file) === claimsFile)) throw new Error('claims file cannot be an annotation target');
    recoveryDir = mkdtempSync(join(recoveryBase(root), 'testguard-annotation-recovery-'));
    chmodSync(recoveryDir, 0o700);
    const files = checked.plan.files.filter((file) => file.changed).map((file, index) => {
      const original = `${index}.original`;
      persistRecovery(join(recoveryDir, original), Buffer.from(file.source, 'utf8'));
      return { file: file.file, original, sourceHash: file.sourceHash, proposedHash: sha256(Buffer.from(file.proposed, 'utf8')), identity: file.identity };
    });
    const manifest = { state: 'prepared', projectDir: root, claimsPath: claimsFile, claimsHash: checked.plan.claimsHash, files };
    persistRecovery(join(recoveryDir, 'manifest.json'), Buffer.from(JSON.stringify(manifest)));
    return freezePrepared({ ready: true, plan: checked.plan, claimsPath: claimsFile, recoveryDir, release: lock.release, assertOwned: lock.assertOwned });
  } catch (error) {
    if (recoveryDir) error.recoveryDir = recoveryDir;
    error.lockRelease = lock.release();
    throw error;
  }
}

/** Explicit internal authoring: recoverable descriptor writes, never automatic rollback. */
export function applyAnnotationPlacement({ projectDir, claimsPath, plan }) {
  const handle = prepareAnnotationApply({ projectDir, claimsPath, plan });
  const root = handle.plan.projectDir;
  const files = handle.plan.files.filter((file) => file.changed);
  const report = { state: 'applied', changed: [], touched: [], unchanged: handle.plan.files.filter((file) => !file.changed).map((file) => file.file), failed: [], recoveryDir: handle.recoveryDir };
  let activeFile = null, stage = 'all-target-preflight';
  const checkClaims = () => {
    handle.assertOwned();
    const claims = currentClaims(root, handle.claimsPath);
    if (!validate('claims', claims).ok || sha256(JSON.stringify(claims)) !== handle.plan.claimsHash) throw new Error('claims changed before source write');
    return claims;
  };
  try {
    const checked = revalidateAnnotationPlan({ projectDir: root, claims: checkClaims(), plan: handle.plan });
    if (!checked.current) throw new Error(`annotation write preflight refused: ${checked.reason}`);
    if (files.length) {
      stage = 'started-journal';
      persistRecovery(join(handle.recoveryDir, 'started.json'), Buffer.from(JSON.stringify({ files: files.map((file) => file.file) })));
    }
    for (const [index, file] of files.entries()) {
      activeFile = file.file; stage = 'target-preflight';
      checkClaims();
      const target = admittedPath(root, file.file);
      if (target.reason) throw new Error(`target refused: ${target.reason}`);
      const fd = openSync(target.path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try {
        const input = readDescriptor(fd, target.stat);
        if (input.reason || input.sourceHash !== file.sourceHash || !isDeepStrictEqual(input.identity, file.identity)) throw new Error('target changed before source write');
        const current = admittedPath(root, file.file);
        if (current.reason || current.stat.dev !== file.identity.dev || current.stat.ino !== file.identity.ino || current.stat.mode !== file.identity.mode) throw new Error('target path changed before source write');
        handle.assertOwned();
        const bytes = Buffer.from(file.proposed, 'utf8');
        stage = 'source-write'; report.touched.push(file.file);
        let offset = 0;
        while (offset < bytes.length) {
          const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
          if (!Number.isInteger(count) || count <= 0 || count > bytes.length - offset) throw new Error('source write made no valid progress');
          offset += count;
        }
        ftruncateSync(fd, bytes.length);
        fsyncSync(fd);
        stage = 'write-verification';
        const output = readDescriptor(fd, fstatSync(fd));
        const after = admittedPath(root, file.file);
        if (output.reason || output.sourceHash !== sha256(bytes) || !isDeepStrictEqual(output.identity, file.identity) || after.reason || after.stat.dev !== file.identity.dev || after.stat.ino !== file.identity.ino) throw new Error('source write verification failed');
        report.changed.push(file.file);
      } finally { closeSync(fd); }
      stage = 'completion-journal';
      persistRecovery(join(handle.recoveryDir, `${index}.applied.json`), Buffer.from(JSON.stringify({ file: file.file, proposedHash: sha256(Buffer.from(file.proposed, 'utf8')) })));
    }
  } catch (error) {
    report.state = report.touched.length ? 'partial' : 'refused';
    report.failed.push({ file: activeFile, stage, reason: error.message });
  } finally {
    report.lockRelease = handle.release();
    if (!report.lockRelease.released && !report.failed.length) {
      report.state = report.touched.length ? 'partial' : 'refused';
      report.failed.push({ file: null, stage: 'lock-release', reason: report.lockRelease.reason });
    }
  }
  try {
    persistRecovery(join(handle.recoveryDir, 'result.pending.json'), Buffer.from(JSON.stringify(report)));
    renameSync(join(handle.recoveryDir, 'result.pending.json'), join(handle.recoveryDir, 'result.json'));
  }
  catch (error) {
    report.state = report.touched.length ? 'partial' : 'refused';
    report.failed.push({ file: null, stage: 'result-journal', reason: error.message });
  }
  return freezePrepared(report);
}
