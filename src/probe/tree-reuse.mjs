import { gitRaw } from '../git.mjs';

/**
 * Keeping the baseline phase's scratch trees for the fault phase (#293).
 * Creating a tree costs a checkout (seconds on a large repository) and
 * removing one a delete; a baseline never applies a fault, so its tree can
 * serve a fault worker. Never on trust: a tree is reused only when git sees it
 * exactly as it was right after it was created (tracked and untracked files;
 * ignored ones such as the borrowed node_modules are the layout itself).
 */

/** What git says about a tree: the porcelain status, untracked files included. */
export const treeState = (dir) => gitRaw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], dir);

/**
 * The fault slots for workers 1..n-1: each kept tree of that worker index
 * whose state is unchanged, else a fresh one. Kept trees nobody reuses are
 * released. Returns the slots and how many trees were reused.
 */
export function fillSlots({ kept, count, fresh, release, stateOf = (tree) => treeState(tree.iso.root) }) {
  const slots = [];
  let reused = 0;
  const byWorker = new Map(kept.map((tree) => [tree.worker, tree]));
  for (let i = 1; i < count; i++) {
    const tree = byWorker.get(i);
    byWorker.delete(i);
    let clean = false;
    if (tree) {
      try { clean = stateOf(tree) === tree.stateAtCreation; } catch { clean = false; }
      if (!clean) release(tree);
    }
    if (clean) reused++;
    slots.push(clean ? tree : fresh(i));
  }
  for (const tree of byWorker.values()) release(tree);
  return { slots, reused };
}
