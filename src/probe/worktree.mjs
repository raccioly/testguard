import { registerCleanup } from './runners/lifecycle.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, mkdirSync, statSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';

const isSymlink = (path) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
import { join, relative, dirname, sep } from 'node:path';
import { addWorktree, removeWorktree, headSha, gitCommonDir } from '../git.mjs';
import { linkedSourceDirs, within, workspacePackages } from './workspaces.mjs';
import { withWorktreeLock, worktreeLockDir } from './worktree-lock.mjs';
import { PreconditionError } from './precondition-error.mjs';
import { installChanges, installFingerprint, linkNodeModules, writable } from './node-modules-link.mjs';
import { scratchConfigured, scratchRoot } from '../scratch-dir.mjs';
import { recordOwner } from '../clean/owner.mjs';

export { PreconditionError };

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
export function createScratch({ repoRoot, projectDir, ref = 'HEAD', scratchBase = scratchRoot(), nodeModules }) {
  const sha = headSha(repoRoot, ref);
  if (!sha) {
    if (ref === 'HEAD') throw new PreconditionError('repository has no commits; commit first, or run with --in-place', 'no-commits');
    throw new PreconditionError(`ref ${ref} does not resolve to a commit`, 'ref-unresolved');
  }
  // Allocation and removal both rewrite the repository's shared worktree
  // registry; a concurrent probe on the same repository waits its turn (#237).
  // The lock is keyed by the repository and kept out of it.
  const lockDir = worktreeLockDir(gitCommonDir(repoRoot));
  const dest = mkdtempSync(join(scratchBase, 'testguard-'));
  // Who owns this tree, written before anything else so an interrupted probe's
  // tree is provably an orphan for the next run (#311).
  const dropOwner = recordOwner(scratchBase, dest, { repo: gitCommonDir(repoRoot) });
  const remove = () => withWorktreeLock(lockDir, () => removeWorktree(repoRoot, dest));
  const unregister = registerCleanup(remove);
  withWorktreeLock(lockDir, () => addWorktree(repoRoot, dest, sha));
  try {
    layOutNodeModules({ repoRoot, projectDir, dest, nodeModules });
  } catch (error) {
    remove();
    dropOwner();
    unregister();
    throw error;
  }
  return {
    mode: 'worktree',
    sha,
    root: dest,
    projectDir: join(dest, relative(repoRoot, projectDir)),
    cleanup: () => { remove(); dropOwner(); unregister(); },
  };
}

/**
 * The scratch tree's node_modules: the main tree's installs, borrowed entry by
 * entry, EXCEPT a link into the repository's own source — a workspace package
 * (`node_modules/@scope/pkg -> ../../packages/pkg`) or a `file:`/`link:`
 * dependency. That one is pointed at the scratch tree's copy of the package
 * (#263): borrowed as it is, it resolves to the ORIGINAL checkout's copy, the
 * defenders run code the fault was never applied to, and a fault in one
 * package that a sibling package defends is never measured. One layout per
 * tree, every tree (the fan-out's and the re-measure's included), and nothing
 * is written into the shared install, so a read-only one is fine.
 *
 * A link into repository source the scratch tree does not contain (an
 * ignored or uncommitted package) cannot be pointed anywhere honest: the run
 * is refused, naming the link. GATE-SEMANTICS rule 9.
 */
/** Every install a scratch tree borrows from: the main tree's node_modules, each workspace package's, and --node-modules. */
function borrowedInstalls({ repoRoot, projectDir, nodeModules }) {
  const repoReal = realpathSync(repoRoot);
  const links = findNodeModules(repoRoot);
  // Workspace packages deeper than findNodeModules looks still have their own node_modules.
  for (const dir of workspacePackages(repoReal, repoReal).values()) {
    const rel = relative(repoReal, join(dir, 'node_modules'));
    if (!within(repoReal, dir) || links.some((link) => link.rel === rel) || !existsSync(join(dir, 'node_modules'))) continue;
    links.push({ rel, target: realpathSync(join(dir, 'node_modules')) });
  }
  if (nodeModules) {
    // Explicit override: link it where the probed project expects it.
    const rel = join(relative(repoRoot, projectDir), 'node_modules');
    links.unshift({ rel, target: realpathSync(nodeModules) });
  }
  return links;
}

/**
 * A fingerprint of every install a scratch tree borrows, taken before a run
 * and compared after it (#279). `installsChangedSince` names each path whose
 * entry changed: something wrote into the user's install, and the run's
 * verdicts cannot be reported.
 */
export function installsFingerprint({ repoRoot, projectDir = repoRoot, nodeModules }) {
  const all = new Map();
  for (const { target } of borrowedInstalls({ repoRoot, projectDir, nodeModules })) for (const [path, sig] of installFingerprint(target)) all.set(path, sig);
  return all;
}
export function installsChangedSince(before, { repoRoot, projectDir = repoRoot, nodeModules }) {
  return installChanges(before, installsFingerprint({ repoRoot, projectDir, nodeModules }));
}

function layOutNodeModules({ repoRoot, projectDir, dest, nodeModules }) {
  const repoReal = realpathSync(repoRoot);
  const links = borrowedInstalls({ repoRoot, projectDir, nodeModules });
  const destReal = realpathSync(dest);
  const carried = new Set();
  const outside = [];
  for (const { rel, target } of links) {
    const at = join(dest, rel);
    // A node_modules the checkout itself holds as a SYMLINK (committed, or
    // captured by an --include-dirty snapshot of a worktree whose
    // node_modules links to the main checkout's) is a level a package manager
    // writes through, into the user's install (#279). It is replaced by the
    // scratch tree's own layout. A real committed directory is left alone.
    if (isSymlink(at)) unlinkSync(at);
    else if (existsSync(at)) continue;
    mkdirSync(dirname(at), { recursive: true });
    // The checkout this install's links were written for: the main tree, or
    // another checkout whose node_modules the main tree borrows.
    const suffix = `${sep}${rel}`;
    const sources = [...new Set([target.endsWith(suffix) ? target.slice(0, -suffix.length) : null, repoReal].filter(Boolean))];
    linkNodeModules(target, at, {
      rewrite: sources.map((source) => ({ from: source, to: destReal })),
      redirect: (from) => {
        for (const source of sources) {
          const dirs = linkedSourceDirs(from, source);
          if (!dirs?.length) continue;
          for (const dir of dirs) {
            const mapped = join(dest, relative(source, dir));
            if (!existsSync(mapped) || !within(destReal, realpathSync(mapped))) continue;
            if (!carried.has(mapped)) { carried.add(mapped); carryIgnored(dir, mapped); }
            return mapped;
          }
          outside.push(`${rel}/${relative(target, from).split(sep).join('/')} -> ${relative(source, dirs[0]).split(sep).join('/')}`);
          return null;
        }
        return null;
      },
    });
  }
  if (outside.length) {
    throw new PreconditionError(
      `the scratch worktree cannot contain what ${outside.length === 1 ? 'this workspace link names' : 'these workspace links name'}: ${outside.join(', ')}. ` +
      'Each links to a package inside the repository that is not in the commit being probed (ignored or uncommitted), so the defenders would run the original checkout\'s copy and no fault applied in the scratch tree could execute there. ' +
      'Commit the package, or run with --in-place.',
      'workspace-link-outside-tree',
    );
  }
}

/**
 * A workspace package's ignored top-level entries (a build's `dist/`) are not
 * in the commit, so the scratch copy lacks them and a package whose entry is
 * its build output would not load. They are linked from the source package.
 * A fault in the package's source does not reach a build output; when the
 * defenders load only that, the negative control reports the fault
 * `subject-not-executed` rather than a verdict about code that never ran.
 * Uncommitted source that is not ignored is never carried: it is not part of
 * the commit being probed.
 */
function carryIgnored(sourceDir, destDir) {
  let entries;
  try { entries = readdirSync(sourceDir); } catch { return; }
  const absent = entries.filter((entry) => entry !== 'node_modules' && entry !== '.git' && !existsSync(join(destDir, entry)));
  if (!absent.length) return;
  const r = spawnSync('git', ['check-ignore', '--stdin', '-z'], { cwd: sourceDir, input: absent.join('\0'), encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0 && r.status !== 1) return;
  for (const entry of (r.stdout ?? '').split('\0').filter(Boolean)) {
    if (!absent.includes(entry)) continue;
    const from = join(sourceDir, entry);
    symlinkSync(from, join(destDir, entry), statSync(from).isDirectory() ? 'dir' : 'file');
  }
}

/** No isolation: mutate the user's tree and rely on restore. */
export function inPlace({ repoRoot, projectDir }) {
  return { mode: 'in-place', root: repoRoot, projectDir, cleanup: () => {} };
}

/**
 * The write boundary a run started under, as the evidence records it: a signal,
 * never a path. `scratchDir` says whether the caller named one; `nodeModulesWritable`
 * whether any node_modules the run links (or its `--node-modules`) could be
 * written, absent when there is none (a Python project). A reader who sees
 * `false` knows the verdicts were measured with the install read-only.
 */
export function writeBoundary({ repoRoot, nodeModules }) {
  const targets = [...(nodeModules ? [realpathSync(nodeModules)] : []), ...findNodeModules(repoRoot).map((link) => link.target)];
  return {
    scratchDir: scratchConfigured() ? 'configured' : 'default',
    ...(targets.length ? { nodeModulesWritable: targets.some(writable) } : {}),
  };
}
