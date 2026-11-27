import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { matchGlobs } from '../util/glob.mjs';
import { scratchConfigured, scratchRoot } from '../scratch-dir.mjs';

/**
 * `--test-glob` / `"testGlobs"` (#332): the files a `--runner-cmd` suite is
 * made of, for a suite no built-in glob lists (JUnit, Apex, MUnit). A custom
 * command has no native listing, so without these the escalation universe is
 * the adapter's JavaScript globs plus the declared defenders, and a survivor
 * is never asked about a test no claim names.
 */

/**
 * Why a glob cannot be used, or undefined when it can. Globs are read against
 * the project directory with `/` as the separator: an absolute path, a drive,
 * a backslash or a `..` segment would leave it, and a glob that quietly
 * matched nothing is the failure this option exists to end.
 */
export function checkTestGlob(glob) {
  if (typeof glob !== 'string') return 'must be a string';
  if (glob.trim() === '') return 'must not be empty';
  if (/^(\/|[A-Za-z]:)/.test(glob) || glob.includes('\\') || isAbsolute(glob)) return 'must be a glob relative to the project directory, written with "/"';
  if (glob.split('/').includes('..')) return 'must stay inside the project directory (no ".." segment)';
  return undefined;
}

/** The globs as the universe sees them: sorted and de-duplicated, so the order typed never changes a hash. */
export const normalizeTestGlobs = (globs) => [...new Set(globs ?? [])].sort();

const realOrResolved = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };

/**
 * The files under `projectDir` that any glob matches, sorted. Dependency and
 * tool directories (`node_modules`, `.git`, `.testguard`, build output) are
 * never walked, and neither is the run's scratch directory when it sits inside
 * the tree: a scratch worktree holds copies of the tests, not tests.
 */
export function matchTestGlobs(projectDir, globs, { scratchDir } = {}) {
  const list = normalizeTestGlobs(globs);
  if (list.length === 0) return [];
  const root = realOrResolved(projectDir);
  const scratch = scratchDir !== undefined ? realOrResolved(scratchDir) : scratchConfigured() ? realOrResolved(scratchRoot()) : undefined;
  return matchGlobs(root, list).filter((file) => {
    if (scratch === undefined) return true;
    const inside = relative(scratch, join(root, file));
    return inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside);
  });
}
