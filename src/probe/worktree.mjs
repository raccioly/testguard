import { existsSync, mkdtempSync, readdirSync, symlinkSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { addWorktree, removeWorktree, headSha } from '../git.mjs';

export class PreconditionError extends Error {}

/**
 * Find every node_modules directory in the main tree (to a shallow depth) so
 * the scratch worktree can borrow them instead of reinstalling.
 */
function findNodeModules(root, depth = 3) {
  const found = [];
  const visit = (dir, rel, d) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === 'node_modules') {
        found.push(relPath);
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
export function createScratch({ repoRoot, projectDir, scratchBase = tmpdir() }) {
  if (!headSha(repoRoot)) {
    throw new PreconditionError('repository has no commits; commit first, or run with --in-place');
  }
  const dest = mkdtempSync(join(scratchBase, 'testguard-'));
  addWorktree(repoRoot, dest);
  for (const rel of findNodeModules(repoRoot)) {
    const target = join(dest, rel);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(join(repoRoot, rel), target, 'dir');
  }
  return {
    mode: 'worktree',
    root: dest,
    projectDir: join(dest, relative(repoRoot, projectDir)),
    cleanup: () => removeWorktree(repoRoot, dest),
  };
}

/** No isolation: mutate the user's tree and rely on restore. */
export function inPlace({ repoRoot, projectDir }) {
  return { mode: 'in-place', root: repoRoot, projectDir, cleanup: () => {} };
}
