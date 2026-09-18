import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Every live mutation registers its restore here so a signal or crash can
// undo all of them before the process dies. Worktree mode makes this
// belt-and-braces; in-place mode depends on it.
const live = new Set();
let handlersInstalled = false;

function restoreAll() {
  for (const restore of live) {
    try {
      restore();
    } catch {}
  }
  live.clear();
}

function installHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      restoreAll();
      process.exit(130);
    });
  }
  process.on('uncaughtException', (err) => {
    restoreAll();
    throw err;
  });
  process.on('exit', restoreAll);
}

function countOccurrences(haystack, needle) {
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

/** Does the anchor hit exactly as declared? */
export function locate(source, fault) {
  const hits = countOccurrences(source, fault.find);
  const expected = fault.expectHits ?? 1;
  if (hits === 0) return { status: 'anchor-missing', hits, expected };
  if (hits !== expected) return { status: 'anchor-ambiguous', hits, expected };
  return { status: 'ok', hits, expected };
}

/** Replace the declared occurrence of `find`. Pure; assumes `locate` returned ok. */
export function mutate(source, fault) {
  const nth = fault.occurrence ?? 1;
  let idx = -1;
  for (let k = 0; k < nth; k++) {
    idx = source.indexOf(fault.find, idx + 1);
    if (idx === -1) throw new RangeError(`occurrence ${nth} of anchor not found`);
  }
  return source.slice(0, idx) + fault.replace + source.slice(idx + fault.find.length);
}

/**
 * Apply a fault to a file on disk. Returns a handle whose `restore()` puts the
 * original back; restore is idempotent and also runs on process exit/signal.
 *
 * `inPlace` decides what a *missing* target means at restore time, and the two
 * modes are opposites. In worktree mode the mutation only ever existed inside a
 * scratch worktree that is discarded at the end of the run, so a target that has
 * vanished is already restored in every sense that matters — a parallel session
 * pruning its own leaked worktrees is enough to cause it, and throwing there
 * converts a harmless cleanup race into a probe that dies with no evidence at
 * all. In `--in-place` mode the same condition means the user's own file is
 * gone, and silence would be the worst possible answer.
 */
export function applyFault(projectDir, fault, { inPlace = false } = {}) {
  installHandlers();
  const path = join(projectDir, fault.file);
  const original = readFileSync(path, 'utf8');
  const anchor = locate(original, fault);
  if (anchor.status !== 'ok') return { anchor, applied: false, restore: () => {} };

  let restored = false;
  const handle = { anchor, applied: true, restore: null };
  const restore = () => {
    if (restored) return;
    restored = true;
    live.delete(restore);
    try {
      writeFileSync(path, original);
    } catch (err) {
      // Only a target that is no longer there. A permission failure or a
      // directory where a file should be can still mean a mutated file left on
      // disk, and those must stay loud in either mode.
      if (inPlace || err.code !== 'ENOENT') throw err;
      handle.restoreSkipped = 'target-missing';
    }
  };
  handle.restore = restore;
  live.add(restore);
  writeFileSync(path, mutate(original, fault));
  return handle;
}
