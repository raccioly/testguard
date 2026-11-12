import { accessSync, constants, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Dot-entries of a node_modules that belong to the install. Every other
 * dot-DIRECTORY is a tool's own cache or scratch space (`.vite`, `.vite-temp`,
 * `.vitest`, `.vitest-cache`, `.cache`, ...) and is not carried into the
 * scratch tree. Dot-FILES are install metadata a package manager reads to
 * decide whether the install is current (`.modules.yaml`,
 * `.pnpm-workspace-state-v1.json`, `.package-map.json`, `.package-lock.json`,
 * `.yarn-integrity`): each is carried as a COPY, so a rewrite stays in the
 * scratch tree.
 */
const INSTALL_DOT_DIRS = new Set(['.bin', '.pnpm']);

/** Below this many levels a directory is linked, not mirrored (a bound, not a layout any manager writes). */
const MAX_DEPTH = 8;

const isDirectory = (path) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

/**
 * Make `at` the scratch tree's node_modules for the install at `target`
 * (#239, #279).
 *
 * The rule: **no level a package manager may write is a link into the
 * user's install.** A runner command can run a package manager in the scratch
 * tree (`pnpm vitest …` verifies the install first and relinks when it thinks
 * it is stale), and whatever it writes must land in the scratch tree. Linking a
 * directory (a scope, `.bin`, `.pnpm`, a package's own `node_modules`) or a
 * metadata file would send those writes into the user's install — measured on
 * a pnpm workspace: 32 entries of the main checkout rewritten to point into a
 * scratch directory that was then deleted. So:
 *   - every node_modules-level directory (the root, scopes, `.bin`, `.pnpm`,
 *     `.pnpm/<id>`, `.pnpm/<id>/node_modules`, a package's nested
 *     `node_modules`) is a real directory in the scratch tree, mirrored;
 *   - every file at such a level (bin shims, install metadata) is a copy;
 *   - every symlink is a new symlink to its resolved target, never a link to
 *     the user's link (replacing it replaces ours);
 *   - a package directory is a read-only leaf: linked whole when it has no
 *     `node_modules` of its own, else mirrored one level (its files linked,
 *     its `node_modules` mirrored).
 * `redirect(from)` may say where a symlink belongs instead (a workspace
 * package: the scratch tree's own copy, #263). Nothing is written into the
 * shared install, so a read-only one works.
 *
 * Install metadata can also NAME the user's checkout: pnpm's
 * `.pnpm-workspace-state-v1.json` lists each workspace project by absolute
 * path, and a `pnpm` run in the scratch tree that trusts it installs into
 * those projects — the user's. `rewrite` maps each such checkout root to the
 * scratch tree in every copied metadata file, so the state describes the tree
 * it sits in.
 */
export function linkNodeModules(target, at, { redirect, rewrite = [] } = {}) {
  mirrorLevel(target, at, { redirect, rewrite }, 0);
}

const MAX_METADATA_BYTES = 8 * 1024 * 1024;

function copyMetadata(from, to, rewrite) {
  const name = from.slice(from.lastIndexOf('/') + 1);
  if (!rewrite.length || !name.startsWith('.') || statSync(from).size > MAX_METADATA_BYTES) { copyFileSync(from, to); return; }
  let text = readFileSync(from, 'utf8');
  // Longest root first, so a nested checkout is not half-rewritten by its parent.
  for (const { from: root, to: dest } of [...rewrite].sort((a, b) => b.from.length - a.from.length)) text = text.split(root).join(dest);
  writeFileSync(to, text);
}

function mirrorLevel(src, dst, options, depth) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    if (entry.startsWith('.') && !INSTALL_DOT_DIRS.has(entry) && isDirectory(from) && !lstatSync(from).isSymbolicLink()) continue; // a tool's cache
    place(from, join(dst, entry), options, depth);
  }
}

function place(from, to, options, depth) {
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) {
    const redirected = options.redirect?.(from);
    let targetPath = redirected;
    if (!targetPath) {
      try { targetPath = realpathSync(from); } catch { targetPath = resolve(dirname(from), readlinkSync(from)); } // dangling: keep it dangling, never pointing back at the user's link
    }
    symlinkSync(targetPath, to, isDirectory(targetPath) ? 'dir' : 'file');
    return;
  }
  if (stat.isFile()) { copyMetadata(from, to, options.rewrite); return; }
  if (!stat.isDirectory()) return;
  if (depth >= MAX_DEPTH) { symlinkSync(from, to, 'dir'); return; }
  let isPackage = false;
  try { isPackage = statSync(join(from, 'package.json')).isFile(); } catch {}
  if (!isPackage) { mirrorLevel(from, to, options, depth + 1); return; }
  const nested = join(from, 'node_modules');
  let hasNested = false;
  try { hasNested = lstatSync(nested).isDirectory(); } catch {}
  if (!hasNested) { symlinkSync(from, to, 'dir'); return; }
  mkdirSync(to);
  for (const entry of readdirSync(from)) {
    if (entry === 'node_modules') mirrorLevel(nested, join(to, entry), options, depth + 1);
    else symlinkSync(join(from, entry), join(to, entry), isDirectory(join(from, entry)) ? 'dir' : 'file');
  }
}

/**
 * A cheap fingerprint of an install's levels a package manager writes: each
 * mirrored level's entries (name, kind, link target; size and mtime for a
 * file) for the root, its scopes, `.bin`, `.pnpm` and `.pnpm/node_modules`.
 * Compared before and after a run (#279): a difference means something wrote
 * into the user's install.
 */
export function installFingerprint(target) {
  const out = new Map();
  const level = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.name.startsWith('.') && entry.isDirectory() && !INSTALL_DOT_DIRS.has(entry.name)) continue;
      let sig;
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) sig = `l:${readlinkSync(path)}`;
        else if (stat.isFile()) sig = `f:${stat.size}:${stat.mtimeMs}`;
        else if (stat.isDirectory()) sig = 'd';
        else sig = 'o';
      } catch { sig = 'gone'; }
      out.set(path, sig);
      const container = entry.isDirectory() && (entry.name.startsWith('@') || entry.name === '.bin' || entry.name === '.pnpm' || (entry.name === 'node_modules' && dir.endsWith('.pnpm')));
      if (container && depth < 2) level(path, depth + 1);
    }
  };
  level(target, 0);
  return out;
}

/** Paths whose fingerprint differs, appeared or disappeared. */
export function installChanges(before, after) {
  const changed = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) if (before.get(path) !== after.get(path)) changed.push(path);
  return changed.sort();
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
