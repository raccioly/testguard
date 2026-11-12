/**
 * A corpus subject as the harness sees it: its configuration, claims and
 * answer key, a preflight that refuses to run without its dependencies, and a
 * fresh git repository holding a copy of it for one TestGuard run.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { LayoutError, copySubjectFiles, linkDependencies, placeIgnoredCopies } from './layout.mjs';
import { basename, dirname, join, relative, resolve } from 'node:path';

export const CORPUS = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** Thrown for a subject that cannot be measured at all. Never a pass. */
export class SubjectError extends Error {}

export function listSubjects() {
  const out = [];
  for (const e of readdirSync(CORPUS, { withFileTypes: true })) {
    if (!e.isDirectory() || !existsSync(join(CORPUS, e.name, 'subject.json'))) continue;
    const config = JSON.parse(readFileSync(join(CORPUS, e.name, 'subject.json'), 'utf8'));
    if (config.variants) for (const v of Object.keys(config.variants)) out.push(`${e.name}@${v}`);
    else out.push(e.name);
  }
  return out.sort();
}

/** `name` or `name@variant` → the subject directory and the variant. */
export function subjectRef(ref) {
  const [name, variant] = ref.split('@');
  return { dir: join(CORPUS, name), variant };
}

/**
 * Loads a subject. `dir` is a corpus subject or, for a private project, any
 * directory; `keyPath` then names its expected.json and `claimsPath` its
 * claims (both default to files inside the directory).
 */
export function loadSubject(dir, { keyPath, claimsPath, configPath, variant } = {}) {
  const abs = resolve(dir);
  const read = (p, what) => {
    if (!existsSync(p)) throw new SubjectError(`${basename(abs)}: ${what} not found at ${p}`);
    return JSON.parse(readFileSync(p, 'utf8'));
  };
  const config = read(configPath ?? join(abs, 'subject.json'), 'subject.json');
  let variantName = null;
  if (config.variants) {
    variantName = variant ?? Object.keys(config.variants)[0];
    if (!config.variants[variantName]) throw new SubjectError(`${basename(abs)}: no variant ${variantName}`);
    Object.assign(config, config.variants[variantName]);
  }
  const claimsFile = claimsPath ? resolve(claimsPath) : join(abs, 'claims.json');
  const claims = read(claimsFile, 'claims').claims;
  const key = read(keyPath ? resolve(keyPath) : join(abs, 'expected.json'), 'answer key');
  const faultIds = claims.flatMap((c) => c.faults.map((f) => `${c.id}/${f.id}`));
  const keyed = Object.keys(key.expected);
  const unkeyed = faultIds.filter((id) => !keyed.includes(id));
  const stale = keyed.filter((id) => !faultIds.includes(id));
  if (unkeyed.length || stale.length) throw new SubjectError(`${basename(abs)}: key and claims disagree (unkeyed: ${unkeyed.join(', ') || 'none'}; keyed but absent: ${stale.join(', ') || 'none'})`);
  const name = `${config.name ?? basename(abs)}${variantName ? `@${variantName}` : ''}`;
  return { name, dir: abs, config, claims, claimsFile, key, faultIds };
}

/** The interpreter a Python subject runs under: --python, TESTGUARD_PYTHON, then the subject's own .venv. */
export function pythonFor(subject, explicit) {
  return explicit ?? process.env.TESTGUARD_PYTHON ?? subject.config.python ?? join(subject.dir, '.venv', 'bin', 'python');
}

/**
 * Refuses a subject whose dependencies are not installed. An uninstalled
 * subject would make every fault `unverifiable` or every run a precondition
 * failure, and an empty or failed comparison is a failure, never a pass.
 */
export function preflight(subject, { python } = {}) {
  const { runner, install } = subject.config;
  const hint = subject.config.installHint ?? `node corpus/run.mjs --install --subject ${subject.name}`;
  if (runner === 'pytest' || runner === 'unittest') {
    const py = pythonFor(subject, python);
    const r = spawnSync(py, ['-c', runner === 'pytest' ? 'import pytest; print(pytest.__version__)' : 'import unittest'], { encoding: 'utf8' });
    if (r.status !== 0) throw new SubjectError(`${subject.name}: ${runner} is not importable from ${py} (${(r.stderr || r.error?.message || '').trim().split('\n').pop()}). Install it: ${hint}`);
    return;
  }
  if (runner === 'node-test') {
    if (install === 'npm-workspace') {
      for (const link of subject.config.workspaceLinks ?? []) {
        if (!existsSync(join(subject.dir, 'node_modules', link))) throw new SubjectError(`${subject.name}: workspace link node_modules/${link} is missing. Install it: ${hint}`);
      }
    }
    return;
  }
  if (install === 'none') return;
  const bin = join(subject.dir, 'node_modules', '.bin', runner);
  if (!existsSync(bin)) throw new SubjectError(`${subject.name}: ${runner} is not installed (no ${relative(CORPUS, bin)}). Install it: ${hint}`);
  if (subject.config.typecheck && !existsSync(join(subject.dir, 'node_modules', '.bin', 'tsc'))) throw new SubjectError(`${subject.name}: typescript is not installed. Install it: ${hint}`);
}

/** Installs a subject's pinned dependencies (lockfile or requirements.txt). */
export function install(subject, { python } = {}) {
  const { install: kind } = subject.config;
  if (kind === 'npm' || kind === 'npm-workspace') {
    execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: subject.dir, stdio: 'inherit' });
    for (const [cmd, ...args] of subject.config.installExtra ?? []) execFileSync(cmd, args, { cwd: subject.dir, stdio: 'inherit' });
  } else if (kind === 'python-venv') {
    const venv = join(subject.dir, '.venv');
    if (!python && !existsSync(join(venv, 'bin', 'python'))) execFileSync('python3', ['-m', 'venv', venv], { stdio: 'inherit' });
    const py = python ?? join(venv, 'bin', 'python');
    execFileSync(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', join(subject.dir, 'requirements.txt')], { stdio: 'inherit' });
  }
}

const IGNORE = ['node_modules/', '.venv/', '__pycache__/', '.testguard/', '.out/', '.fee_rotation', '.holds_counter', '.verify_rotation', 'test-results/', 'playwright-report/'];

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.email=corpus@example.invalid', '-c', 'user.name=corpus', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export { git };

/**
 * A fresh git repository holding a copy of the subject, committed, with its
 * dependencies reachable the way a developer's checkout has them:
 * node_modules linked from the subject, except a workspace's, whose package
 * links are recreated inside the copy so they resolve to the copy's packages.
 * Every workspace link is then checked to resolve inside the copy.
 */
export function prepareRepo(subject, { scratchRoot, nodeModules } = {}) {
  const dir = mkdtempSync(join(scratchRoot ?? tmpdir(), `corpus-${subject.name.replace('@', '-')}-`));
  copySubjectFiles(subject, dir);
  // Build output a real working tree holds untracked and git-ignored (#272).
  const ignoredTops = placeIgnoredCopies(subject, dir);
  writeFileSync(join(dir, '.gitignore'), `${[...IGNORE, ...ignoredTops].join('\n')}\n`);
  // A project outside the corpus keeps its claims outside the project; the
  // copy carries them as claims.json so every mode can read (and reorder) them.
  if (resolve(subject.claimsFile) !== join(subject.dir, 'claims.json')) cpSync(subject.claimsFile, join(dir, 'claims.json'));
  try {
    linkDependencies(subject, dir, { nodeModules });
  } catch (error) {
    if (error instanceof LayoutError) throw new SubjectError(error.message);
    throw error;
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'subject');
  return dir;
}

/** A read-only copy of the subject's node_modules, and a listing to prove nothing wrote through it. */
export function readOnlyNodeModules(subject, root) {
  const copy = join(root, 'node_modules');
  cpSync(join(subject.dir, 'node_modules'), copy, { recursive: true, verbatimSymlinks: true });
  const lock = (p) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    // Remove the write bits only: native binaries (esbuild) must stay executable.
    if (st.isDirectory()) { for (const e of readdirSync(p)) lock(join(p, e)); chmodSync(p, st.mode & 0o555); } else chmodSync(p, st.mode & 0o555);
  };
  lock(copy);
  return copy;
}

export function listing(dir) {
  const out = [];
  const walk = (p) => {
    const st = lstatSync(p);
    out.push(`${relative(dir, p)}:${st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : st.size}:${st.mtimeMs}`);
    if (st.isDirectory()) for (const e of readdirSync(p).sort()) walk(join(p, e));
  };
  walk(dir);
  return out.join('\n');
}

export function unlockAndRemove(dir) {
  const unlock = (p) => {
    let st;
    try { st = lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { chmodSync(p, 0o755); for (const e of readdirSync(p)) unlock(join(p, e)); } else chmodSync(p, 0o644);
  };
  unlock(dir);
  rmSync(dir, { recursive: true, force: true });
}

/** Applies scripted edits ({file, find, replace} or {rename: [from, to]} or {add: path, content}) and commits them. */
export function commitEdits(dir, edits, message) {
  for (const e of edits) {
    if (e.rename) {
      mkdirSync(dirname(join(dir, e.rename[1])), { recursive: true });
      git(dir, 'mv', e.rename[0], e.rename[1]);
    } else if (e.add) {
      mkdirSync(dirname(join(dir, e.add)), { recursive: true });
      writeFileSync(join(dir, e.add), e.content);
    } else {
      const p = join(dir, e.file);
      const text = readFileSync(p, 'utf8');
      const hits = text.split(e.find).length - 1;
      if (hits !== 1) throw new SubjectError(`scripted edit to ${e.file}: anchor occurs ${hits} times, expected 1 (the subject changed under the key)`);
      writeFileSync(p, text.replace(e.find, () => e.replace));
    }
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

/**
 * A content digest of a dependency install, to prove nothing wrote through it
 * (#279): every regular file's bytes and every symlink's target, by path.
 * `exclude` names top-level entries left out (a runner's own cache).
 */
export function installDigest(root, { exclude = [] } = {}) {
  const h = createHash('sha256');
  const walk = (rel) => {
    if (exclude.includes(rel)) return;
    const p = join(root, rel);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) { h.update(`L ${rel} ${readlinkSync(p)}\n`); return; }
    if (st.isDirectory()) { h.update(`D ${rel}\n`); for (const e of readdirSync(p).sort()) walk(rel ? `${rel}/${e}` : e); return; }
    h.update(`F ${rel} ${st.size}\n`);
    h.update(readFileSync(p));
  };
  walk('');
  return h.digest('hex');
}

/**
 * What the install-unchanged check hashes. A subject whose copies get a real
 * node_modules of links (`nodeModulesLayout: linked-entries`, #279) is hashed
 * byte for byte: anything a runner caches lands in the copy's own directory,
 * so any change to the source install was written through a link. Where a
 * copy's node_modules is one link to the whole install, vite and vitest write
 * their own caches into it (node_modules/.vite, .vite-temp, .vitest-cache:
 * the subject's runner does this with no tool involved), so those three are
 * left out and everything else must be unchanged.
 */
export function installCheckScope(subject) {
  return subject.config.nodeModulesLayout === 'linked-entries' ? { exclude: [] } : { exclude: ['.vite', '.vite-temp', '.vitest-cache'] };
}
