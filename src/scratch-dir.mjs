import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PreconditionError } from './probe/precondition-error.mjs';
import { registerCleanup } from './probe/runners/lifecycle.mjs';

/**
 * The one place TestGuard's temporary files live. A confined caller names a
 * directory (`--scratch-dir`, `TESTGUARD_SCRATCH_DIR`); every scratch worktree,
 * temporary git index, runner report, sidecar and runner cache is created
 * under it. Unset, the base is the operating system's temp directory, as before.
 *
 * The base travels in an AsyncLocalStorage context rather than a module global:
 * `probe()` and `replay()` are library entry points that tests call in-process,
 * and a global would leak one call's directory into the next.
 */
const context = new AsyncLocalStorage();

/** The directory every temporary file goes under: the configured one, else the OS temp directory. */
export const scratchRoot = () => context.getStore() ?? tmpdir();

/** Was a scratch directory named for this run (as opposed to the OS default)? */
export const scratchConfigured = () => context.getStore() !== undefined;

/**
 * A private temp and data directory for one child process, under the scratch
 * root, gone when the child closes. Only when a scratch directory was named:
 * otherwise the child keeps the operating system's own and nothing changes.
 *
 * TMPDIR/TMP/TEMP move the child's temp files. XDG_DATA_HOME moves what a test
 * runner keeps per user (vitest writes an API token there; Linux honors it,
 * macOS and Windows do not, which docs-canonical/SECURITY.md says). HOME is
 * left alone on purpose: a test that reads the caller's git config, browser
 * install or interpreter settings must still find them.
 */
export function childScope() {
  const base = context.getStore();
  if (base === undefined) return { env: {}, dispose: () => {} };
  const dir = mkdtempSync(join(base, 'testguard-child-'));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  const unregister = registerCleanup(remove);
  return {
    env: { TMPDIR: dir, TMP: dir, TEMP: dir, XDG_DATA_HOME: join(dir, 'data') },
    dispose: () => { unregister(); remove(); },
  };
}

/** Run `fn` with `base` as the scratch root. An undefined base leaves the surrounding root alone. */
export const withScratchBase = (base, fn) => (base === undefined ? fn() : context.run(base, fn));

/**
 * The scratch directory an invocation asked for: the flag, else the
 * environment variable, else none. Checked before anything is written: a
 * directory that does not exist or cannot be written is a precondition error
 * (exit 2), never created on the caller's behalf — a confined container's
 * writable workspace is something the caller provisions. Returns the real path
 * (macOS reports /var as /private/var), or undefined when none was named.
 */
export function resolveScratchDir(flag, env = process.env) {
  const named = flag ?? env.TESTGUARD_SCRATCH_DIR;
  if (named === undefined) return undefined;
  if (named.trim() === '') throw new PreconditionError('--scratch-dir (or TESTGUARD_SCRATCH_DIR) must name a directory');
  const path = resolve(named);
  let real;
  try {
    if (!statSync(path).isDirectory()) throw new Error('not a directory');
    real = realpathSync(path);
    // Creating and removing a directory is the real test of "writable": an access(2) check answers yes for root on a path that then fails.
    rmSync(mkdtempSync(join(real, 'testguard-writable-')), { recursive: true, force: true });
  } catch (error) {
    throw new PreconditionError(`scratch directory ${path} is not usable: ${error.code === 'ENOENT' ? 'it does not exist' : error.message}. Create a writable directory and pass it as --scratch-dir (or TESTGUARD_SCRATCH_DIR).`);
  }
  return real;
}
