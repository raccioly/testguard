import { existsSync, mkdtempSync, readdirSync, symlinkSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { addWorktree, removeWorktree, headSha } from '../git.mjs';

export class PreconditionError extends Error {}

/**
 * Find every node_modules directory in the main tree (to a shallow depth) so
 * the scratch worktree can borrow them instead of reinstalling. A symlinked
 * node_modules — the layout a sibling or auto-created worktree produces — is
 * a directory for this purpose, and is linked to its resolved target.
 */
export function findNodeModules(root, depth = 3) {
  const found = [];
  const isDir = (dir, e) => {
    if (e.isDirectory()) return true;
    if (!e.isSymbolicLink()) return false;
    try {
      return statSync(join(dir, e.name)).isDirectory();
    } catch {
      return false;
    }
  };
  const visit = (dir, rel, d) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!isDir(dir, e)) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === 'node_modules') {
        found.push({ rel: relPath, target: realpathSync(join(dir, e.name)) });
      } else if (d < depth && e.name !== '.git' && !e.name.startsWith('.')) {
        visit(join(dir, e.name), relPath, d + 1);
      }
    }
  };
  visit(root, '', 0);
  return found;
}

/**
 * A scratch git worktree at HEAD, with the main tree's node_modules linked in.
 * Faults are applied here; the user's tree is never touched.
 */
export function createScratch({ repoRoot, projectDir, ref = 'HEAD', scratchBase = tmpdir(), nodeModules }) {
  const sha = headSha(repoRoot, ref);
  if (!sha) {
    throw new PreconditionError(ref === 'HEAD' ? 'repository has no commits; commit first, or run with --in-place' : `ref ${ref} does not resolve to a commit`);
  }
  const dest = mkdtempSync(join(scratchBase, 'testguard-'));
  addWorktree(repoRoot, dest, sha);
  const links = findNodeModules(repoRoot);
  if (nodeModules) {
    // Explicit override: link it where the probed project expects it.
    const rel = join(relative(repoRoot, projectDir), 'node_modules');
    links.unshift({ rel, target: realpathSync(nodeModules) });
  }
  for (const { rel, target } of links) {
    const at = join(dest, rel);
    if (existsSync(at)) continue;
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(target, at, 'dir');
  }
  return {
    mode: 'worktree',
    sha,
    root: dest,
    projectDir: join(dest, relative(repoRoot, projectDir)),
    cleanup: () => removeWorktree(repoRoot, dest),
  };
}

/** No isolation: mutate the user's tree and rely on restore. */
export function inPlace({ repoRoot, projectDir }) {
  return { mode: 'in-place', root: repoRoot, projectDir, cleanup: () => {} };
}
