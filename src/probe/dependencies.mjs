/**
 * What a verdict depends on beyond the target and defender files themselves:
 * everything they import, plus the files that decide what gets installed and
 * how the runner is configured.
 *
 * Reuse used to compare only the target and defender files. Break a helper the
 * target imports so the defender goes red, probe again, and the old `killed`
 * was carried forward over a red suite. Every caller that decides whether
 * evidence still describes the tree — verdict reuse in `probe`, the origin
 * policy's freshness check, `status` staleness — computes these inputs here
 * and compares them with `sameDependencies`, so the three cannot disagree.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sha256 } from '../util/hash.mjs';
import { projectImportResolver } from './rank.mjs';
import { pyClosure, pyModuleIndex } from './pyimports.mjs';

export { sameDependencies } from './attribution.mjs';

/**
 * Root-level files that change what the defenders run against without being
 * imported: lockfiles and package manifests (which packages are installed),
 * and runner/compiler configuration. Hashed when present; a file that appears
 * or disappears changes the key set, so equality still breaks.
 */
export const DEPENDENCY_MANIFEST_FILES = Object.freeze([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'pnpm-workspace.yaml', 'pnpm-workspace.yml', 'lerna.json', 'nx.json', 'turbo.json', 'rush.json', 'workspace.json',
  'tsconfig.json', 'jsconfig.json', '.babelrc', 'babel.config.js', 'babel.config.cjs', 'babel.config.mjs', 'babel.config.json',
  ...['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].flatMap((ext) => [`vitest.config.${ext}`, `vite.config.${ext}`, `vitest.workspace.${ext}`, `jest.config.${ext}`, `playwright.config.${ext}`]),
  'vitest.workspace.json', 'jest.config.json',
  'pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'tox.ini', 'requirements.txt', 'requirements-dev.txt',
  'poetry.lock', 'uv.lock', 'Pipfile', 'Pipfile.lock', 'pdm.lock',
]);

/** At most this many closure issues are recorded; the closure is indeterminate either way. */
export const MAX_DEPENDENCY_ISSUES = 16;

const isPython = (file) => file.endsWith('.py');

/** A project-relative file's hash, or null when it is missing, a link out of the project, or not a regular file. */
function hashInside(root, file) {
  try {
    const path = join(root, file);
    const inside = relative(root, realpathSync(path));
    if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`) || !lstatSync(path).isFile()) return null;
    return sha256(readFileSync(path));
  } catch { return null; }
}

/**
 * One hasher per command and project tree. `cache` is only safe while the
 * tree cannot change underneath — the scratch worktree, between faults — so
 * callers on a live tree pass `cache: false`.
 */
export function createDependencyHasher(projectDir, { cache = true, limits } = {}) {
  const root = realpathSync(resolve(projectDir));
  let resolver;
  let pyIndex;
  const hashes = new Map();
  const freshResolver = () => projectImportResolver(root, limits ? { limits } : {});
  const hashOf = (file) => {
    if (cache && hashes.has(file)) return hashes.get(file);
    const value = hashInside(root, file);
    if (cache) hashes.set(file, value);
    return value;
  };

  /**
   * `inputs.dependencyHashes` and `inputs.dependencyClosure` for a fault whose
   * target and resolved defenders are `roots` (project-relative).
   */
  function inputsFor(roots) {
    const js = roots.filter((file) => !isPython(file));
    const py = roots.filter(isPython);
    const files = new Set();
    const issues = [];
    if (js.length) {
      const result = (cache ? (resolver ??= freshResolver()) : freshResolver()).closure(js.map((file) => join(root, file)));
      for (const file of result.files) files.add(file);
      issues.push(...(result.issues ?? []));
    }
    if (py.length) {
      const index = cache ? (pyIndex ??= pyModuleIndex(root)) : pyModuleIndex(root);
      const result = pyClosure(root, py, { index, ...(limits ? { limits } : {}) });
      for (const file of result.files) files.add(file);
      issues.push(...(result.issues ?? []));
    }
    for (const file of DEPENDENCY_MANIFEST_FILES) if (existsSync(join(root, file))) files.add(file);
    const dependencyHashes = {};
    for (const file of [...files].sort()) {
      const hash = hashOf(file);
      if (hash === null) {
        // Named by the closure but unreadable now: an input we cannot vouch for.
        if (!issues.some((entry) => entry.file === file)) issues.push({ code: 'unreadable-module', file });
        continue;
      }
      dependencyHashes[file] = hash;
    }
    return {
      dependencyHashes,
      dependencyClosure: issues.length ? 'indeterminate' : 'complete',
      ...(issues.length ? { dependencyIssues: issues.slice(0, MAX_DEPENDENCY_ISSUES) } : {}),
    };
  }

  return { inputsFor };
}

/**
 * Why `sameDependencies` would refuse, as readable lines for `status`. Empty
 * when it would accept — or when the only reason is that a closure cannot be
 * followed: that is a reason never to *reuse* the record, and the next probe
 * re-measures it, but it is not a change, and reporting it as stale would
 * leave `status` stale forever with nothing an agent could do about it.
 */
export function dependencyChanges(recorded, current, key) {
  if (!recorded?.dependencyHashes) return [`${key} predates dependency hashing and cannot be reused`];
  const changes = [];
  const before = recorded.dependencyHashes;
  const after = current.dependencyHashes;
  for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(file in after)) changes.push(`${file} is no longer an input of ${key}`);
    else if (!(file in before)) changes.push(`${file} became an input of ${key} since it was probed`);
    else if (before[file] !== after[file]) changes.push(`${file} changed since ${key} was probed`); // same words as the target/defender lines, so they de-duplicate
  }
  return changes;
}
