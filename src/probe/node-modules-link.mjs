import { accessSync, constants, lstatSync, mkdirSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Dot-entries of a node_modules that are part of the install and read-only in
 * use. Every other dot-entry is a tool's own cache or scratch space
 * (`.vite`, `.vite-temp`, `.vitest`, `.vitest-cache`, `.cache`, ...) and is
 * deliberately not carried into the scratch tree: it would be written through
 * the link into the shared install. An unlisted entry is left out, which fails
 * loud (a tool that needed it says so), never silent (a write into the install).
 */
const INSTALL_DOT_ENTRIES = new Set(['.bin', '.pnpm', '.package-lock.json', '.yarn-integrity', '.yarn-state.yml', '.modules.yaml']);

const isDirectory = (path) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};
const isLink = (path) => {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
};

/**
 * Make `at` a node_modules for the scratch tree: a real directory in the
 * scratch worktree whose entries link to the shared install's. Resolution is
 * unchanged — every package is the one the install holds, found by the same
 * name — but a tool that writes into `<project>/node_modules/.something` writes
 * into the scratch tree, and is gone with it. Linking the directory itself
 * would send those writes to the shared install, and to a read-only one they
 * would fail (vite's config loader dies on `.vite-temp` there).
 */
export function linkNodeModules(target, at, { redirect } = {}) {
  mkdirSync(at, { recursive: true });
  for (const entry of readdirSync(target)) {
    if (entry.startsWith('.') && !INSTALL_DOT_ENTRIES.has(entry)) continue;
    const from = join(target, entry);
    if (redirect && entry.startsWith('@') && isDirectory(from) && !isLink(from)) {
      // A scope directory holds packages one by one, and a workspace package
      // among them must be linked on its own (#263): linking the scope whole
      // would resolve `@scope/pkg` through the shared install, to the copy
      // the install's checkout holds.
      mkdirSync(join(at, entry));
      for (const name of readdirSync(from)) place(join(from, name), join(at, entry, name), redirect);
      continue;
    }
    place(from, join(at, entry), redirect);
  }
}

/** Link `to` to the install's entry `from`, or to where `redirect` says that entry belongs instead. */
function place(from, to, redirect) {
  const target = redirect?.(from) ?? from;
  symlinkSync(target, to, isDirectory(target) ? 'dir' : 'file');
}

/** Can the shared install be written to? A signal for the evidence; never a path. */
export function writable(target) {
  try {
    accessSync(target, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the node_modules a tool run from `dir` would find (the nearest one up the
 * tree) writable? Undefined when there is none. Used where a run happens in the
 * caller's own tree, which cannot be given a scratch node_modules.
 */
export function nearestNodeModulesWritable(dir) {
  for (let at = dir; ; at = dirname(at)) {
    const candidate = join(at, 'node_modules');
    if (isDirectory(candidate)) return writable(candidate);
    if (dirname(at) === at) return undefined;
  }
}
