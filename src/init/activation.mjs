import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Is the pre-push hook file on this clone's ACTIVE hooks path? (#301, item 9.)
 *
 * `init` writes `.githooks/pre-push`, but git runs it only when core.hooksPath
 * points at that directory, when husky owns the hooks path, or when a hook in
 * the active directory calls it. In three of six clones nobody had said
 * `git config core.hooksPath .githooks`, so the documented gate never ran.
 *
 * Reads git only; `activateHook` is the one function that writes, and only when
 * the caller was told to (`init --activate-hook`). Works from a linked
 * worktree: git's own `--git-path hooks` answers for the shared hooks
 * directory, so no path is guessed from `.git`.
 */

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
/** realpath of the deepest ancestor that exists, then the rest: a directory init is about to write still compares equal. */
const real = (p) => {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { return join(real(dirname(abs)), abs.slice(dirname(abs).length + 1)); }
};
const posix = (p) => p.split(sep).join('/');

/** The directory git runs hooks from in `root`, absolute, with core.hooksPath applied; null outside a repository. */
function activeHooksDir(root) {
  const r = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  if (r.status !== 0 || !r.stdout.trim()) return null;
  const p = r.stdout.trim();
  return real(isAbsolute(p) ? p : join(root, p));
}

/** Files in a hooks directory other than git's `.sample` templates. */
const otherHooks = (dir) => { try { return readdirSync(dir).filter((f) => !f.endsWith('.sample')); } catch { return []; } };

/** The wrapper that keeps the hooks already in `.git/hooks` and calls the tracked file. */
export function wrapperScript(hookRel) {
  return `#!/bin/sh
# Calls the tracked TestGuard hook; every other hook here is untouched.
# Written by testguard init --activate-hook.
hook="$(git rev-parse --show-toplevel)/${hookRel}"
[ -f "$hook" ] || exit 0
exec sh "$hook" "$@"
`;
}

/**
 * `{ active: true, how }`, or `{ active: false, kind, fix, ... }` where `kind` is
 * `config` (`.git/hooks` holds nothing of its own: point core.hooksPath at the
 * directory), `wrapper` (it holds other hooks: a small pre-push that calls the
 * tracked file keeps them), `call` (there is already a pre-push there, or
 * core.hooksPath names another directory: add one line to it) or `husky`.
 * `hookFile` is absolute; `root` is the worktree's top level.
 */
export function hookActivation({ root, hookFile }) {
  const dir = activeHooksDir(root);
  if (!dir) return { active: true, how: 'not a git repository' }; // nothing to activate
  const hookRel = posix(relative(root, hookFile));
  const hookDir = real(dirname(hookFile));
  if (hookDir === dir) return { active: true, how: 'core.hooksPath' };
  const husky = real(join(root, '.husky'));
  if (hookDir === husky && (dir === husky || dir === join(husky, '_'))) return { active: true, how: 'husky' };
  // A hook in the active directory that calls the tracked file.
  const there = join(dir, 'pre-push');
  const calls = (() => { try { return readFileSync(there, 'utf8').includes(hookRel); } catch { return false; } })();
  if (calls) return { active: true, how: `${posix(relative(root, there)) || there} calls it` };

  const configured = git(root, ['config', '--get', 'core.hooksPath']).stdout.trim();
  const shown = posix(relative(root, dir)) || '.';
  const callLine = `sh "$(git rev-parse --show-toplevel)/${hookRel}" "$@" || exit 1`;
  const base = { active: false, hookRel, hooksDir: dir, hooksDirShown: shown, configured };
  if (hookDir === husky) {
    return { ...base, kind: 'husky', short: 'run husky\'s install step (npx husky) so core.hooksPath points at .husky/_', fix: 'run husky\'s install step (npx husky, or your package manager\'s prepare script) so core.hooksPath points at .husky/_ ; init does not change git config' };
  }
  if (configured) {
    return { ...base, kind: 'call', short: `core.hooksPath is ${configured}: have ${shown}/pre-push call ${hookRel}`, fix: `core.hooksPath is ${configured}, not ${posix(relative(root, hookDir)) || '.'}: add this line to ${shown}/pre-push (init changes neither):\n  ${callLine}`, snippet: callLine };
  }
  if (existsSync(there)) {
    return { ...base, kind: 'call', short: `have .git/hooks/pre-push call ${hookRel}`, fix: `.git/hooks/pre-push exists and does not call ${hookRel}: add this line to it (init does not edit it):\n  ${callLine}`, snippet: callLine };
  }
  if (otherHooks(dir).length) {
    const wrapper = wrapperScript(hookRel);
    return { ...base, kind: 'wrapper', wrapper, short: `add a .git/hooks/pre-push that calls ${hookRel} (core.hooksPath would disable the other hooks there); testguard init --activate-hook writes it`, fix: `.git/hooks holds other hooks (${otherHooks(dir).join(', ')}), so repointing core.hooksPath would silently disable them. Create .git/hooks/pre-push that calls the tracked file (testguard init --activate-hook writes it):\n${wrapper.trimEnd().replace(/^/gm, '  ')}` };
  }
  return { ...base, kind: 'config', short: `git config core.hooksPath ${posix(relative(root, hookDir)) || '.'}; testguard init --activate-hook runs it`, command: `git config core.hooksPath ${posix(relative(root, hookDir)) || '.'}`, fix: `git config core.hooksPath ${posix(relative(root, hookDir)) || '.'} (testguard init --activate-hook runs it)` };
}

/**
 * Do the recommended thing for an inactive hook (`init --activate-hook`):
 * write the wrapper, or set core.hooksPath. A pre-push that already exists,
 * another hooks directory and husky are never edited. Returns what was done, or why not.
 */
export function activateHook({ root, hookFile }, activation = hookActivation({ root, hookFile })) {
  if (activation.active) return { done: false, message: `${activation.hookRel ?? posix(relative(root, hookFile))} is already on the active hooks path (${activation.how})` };
  if (activation.kind === 'wrapper') {
    const target = join(activation.hooksDir, 'pre-push');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, activation.wrapper, { mode: 0o755 });
    chmodSync(target, 0o755);
    return { done: true, message: `${posix(relative(root, target)) || target}: calls ${activation.hookRel}; the other hooks there are untouched` };
  }
  if (activation.kind === 'config') {
    const dir = posix(relative(root, dirname(hookFile))) || '.';
    const r = git(root, ['config', 'core.hooksPath', dir]);
    if (r.status !== 0) return { done: false, message: `git config core.hooksPath ${dir} failed: ${r.stderr.trim()}` };
    return { done: true, message: `git config core.hooksPath ${dir} (this repository's config, shared by every worktree)` };
  }
  return { done: false, message: `--activate-hook left it: ${activation.fix.split('\n')[0]}` };
}

/** The TestGuard pre-push files a repository carries, with their activation state: what `status` advice reports. */
export function inactiveHooks(root) {
  const out = [];
  for (const rel of ['.husky/pre-push', '.githooks/pre-push']) {
    const file = join(root, rel);
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    if (!/testguard/i.test(text)) continue;
    const a = hookActivation({ root, hookFile: file });
    if (!a.active) out.push({ file: rel, activation: a });
  }
  return out;
}
