import { closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';

/**
 * The owner record of a scratch tree (#311): who created it, so a later run
 * can tell an abandoned tree from a live one. A leaf module (node built-ins
 * only) because the scratch-directory and worktree modules write records and
 * the cleanup module reads them.
 */

export const ownersDir = (base) => join(base, 'testguard-locks', 'owners');

/**
 * Record that this process owns `path` (a scratch tree or child scope under
 * `base`). Returns the function that drops the record. Best effort: a scratch
 * root that cannot hold a record leaves the tree ownerless (removable only by
 * age), never fails the command.
 */
export function recordOwner(base, path, { host = hostname() } = {}) {
  const file = join(ownersDir(base), `${basename(path)}.json`);
  try {
    mkdirSync(ownersDir(base), { recursive: true });
    const fd = openSync(file, 'w');
    try { writeSync(fd, JSON.stringify({ pid: process.pid, host, at: new Date().toISOString() })); } finally { closeSync(fd); }
  } catch { return () => {}; }
  return () => { try { rmSync(file, { force: true }); } catch { /* gone or unwritable */ } };
}

