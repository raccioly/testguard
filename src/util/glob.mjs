import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Dependency and tool directories. The Python entries are not cosmetic: a
// virtualenv inside the project holds thousands of `test_*.py` files belonging
// to installed packages, and without skipping it every one of them would be
// collected as a test file of the project under probe.
// `dist` and `coverage` were here from the start; the framework build outputs
// were not, and the claim above them already promised that "a build's test
// files" are not this project's. A Next.js `.next/` carries compiled copies of
// the application — including its writes and its tests — so a surface scan of a
// real app counted the same code twice and a defender glob could match a
// compiled chunk. The promise was right and the list was short.
// `.claude` holds agent tooling and, under `.claude/worktrees/`, whole nested
// checkouts of OTHER branches. Measured: discovery on a real repository returned
// another branch's test file as a defender — a file the scratch tree cannot
// even contain, because the directory is gitignored.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.testguard', '.claude',
  '.next', '.nuxt', '.svelte-kit', '.output', '.turbo', '.parcel-cache', '.angular', '.astro',
  'build', 'out', '.cache', '.vercel', '.netlify',
  '__pycache__', '.venv', 'venv', 'site-packages', '.tox', '.nox',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.eggs']);

/** Translate a minimal glob (`**`, `*`, `?`) into an anchored RegExp over posix paths. */
export function globToRegExp(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(re + '$');
}

/** The tree changed under a command that had already taken its snapshot: a finding about the run, not about the project. */
export class InventoryError extends Error { kind = 'inventory'; }

let walks = 0;
/** How many times a directory tree was walked in this process. A test reads it to prove one command walks once. */
export const walkCount = () => walks;

/** Every file under `root` as a posix path relative to it, skipping tool and dependency directories. */
export function walk(root) {
  walks++;
  const out = [];
  const visit = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        out.push(relPath);
      }
    }
  };
  visit(root, '');
  return out.sort();
}

/**
 * One walk, kept for a whole command (#231). A command that resolves hundreds of defender lists used to walk
 * the repository for each one. The snapshot is the same list `walk` returns (same skips, same order, same
 * symlink policy), frozen, and bound to the root it was taken from: it answers for that root and no other.
 */
export function createInventory(root) {
  return Object.freeze({ root: resolve(root), files: Object.freeze(walk(root)) });
}

/** Has the tree changed since the snapshot was taken? One fresh walk, compared entry by entry. */
export function inventoryChanged(inventory) {
  const now = walk(inventory.root);
  return now.length !== inventory.files.length || now.some((f, i) => f !== inventory.files[i]);
}

const filesOf = (root, inventory) => {
  if (!inventory) return walk(root);
  if (resolve(root) !== inventory.root) throw new Error(`inventory snapshot of ${inventory.root} cannot answer for ${resolve(root)}`);
  return inventory.files;
};

/** Files under `root` matching any of `globs`. A glob with no wildcard is an exact relative path. */
export function matchGlobs(root, globs, inventory) {
  if (!globs || globs.length === 0) return [];
  const regexps = globs.map(globToRegExp);
  return filesOf(root, inventory).filter((f) => regexps.some((r) => r.test(f)));
}
