/**
 * A corpus subject as the harness sees it: its configuration, claims and
 * answer key, a preflight that refuses to run without its dependencies, and a
 * fresh git repository holding a copy of it for one TestGuard run.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

export const CORPUS = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** Thrown for a subject that cannot be measured at all. Never a pass. */
export class SubjectError extends Error {}

export function listSubjects() {
  return readdirSync(CORPUS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(CORPUS, e.name, 'subject.json')))
    .map((e) => e.name)
    .sort();
}

/**
 * Loads a subject. `dir` is a corpus subject or, for a private project, any
 * directory; `keyPath` then names its expected.json and `claimsPath` its
 * claims (both default to files inside the directory).
 */
export function loadSubject(dir, { keyPath, claimsPath, configPath } = {}) {
  const abs = resolve(dir);
  const read = (p, what) => {
    if (!existsSync(p)) throw new SubjectError(`${basename(abs)}: ${what} not found at ${p}`);
    return JSON.parse(readFileSync(p, 'utf8'));
  };
  const config = read(configPath ?? join(abs, 'subject.json'), 'subject.json');
  const claimsFile = claimsPath ? resolve(claimsPath) : join(abs, 'claims.json');
  const claims = read(claimsFile, 'claims').claims;
  const key = read(keyPath ? resolve(keyPath) : join(abs, 'expected.json'), 'answer key');
  const faultIds = claims.flatMap((c) => c.faults.map((f) => `${c.id}/${f.id}`));
  const keyed = Object.keys(key.expected);
  const unkeyed = faultIds.filter((id) => !keyed.includes(id));
  const stale = keyed.filter((id) => !faultIds.includes(id));
  if (unkeyed.length || stale.length) throw new SubjectError(`${basename(abs)}: key and claims disagree (unkeyed: ${unkeyed.join(', ') || 'none'}; keyed but absent: ${stale.join(', ') || 'none'})`);
  return { name: config.name ?? basename(abs), dir: abs, config, claims, claimsFile, key, faultIds };
}

/** The interpreter a Python subject runs under: --python, TESTGUARD_PYTHON, then the subject's own .venv. */
export function pythonFor(subject, explicit) {
  return explicit ?? process.env.TESTGUARD_PYTHON ?? join(subject.dir, '.venv', 'bin', 'python');
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
  const bin = join(subject.dir, 'node_modules', '.bin', runner);
  if (!existsSync(bin)) throw new SubjectError(`${subject.name}: ${runner} is not installed (no ${relative(CORPUS, bin)}). Install it: ${hint}`);
  if (subject.config.typecheck && !existsSync(join(subject.dir, 'node_modules', '.bin', 'tsc'))) throw new SubjectError(`${subject.name}: typescript is not installed. Install it: ${hint}`);
}

/** Installs a subject's pinned dependencies (lockfile or requirements.txt). */
export function install(subject, { python } = {}) {
  const { install: kind } = subject.config;
  if (kind === 'npm' || kind === 'npm-workspace') {
    execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: subject.dir, stdio: 'inherit' });
  } else if (kind === 'python-venv') {
    const venv = join(subject.dir, '.venv');
    if (!python && !existsSync(join(venv, 'bin', 'python'))) execFileSync('python3', ['-m', 'venv', venv], { stdio: 'inherit' });
    const py = python ?? join(venv, 'bin', 'python');
    execFileSync(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', join(subject.dir, 'requirements.txt')], { stdio: 'inherit' });
  }
}

const IGNORE = ['node_modules/', '.venv/', '__pycache__/', '.testguard/', '.out/', '.fee_rotation', '.holds_counter'];

/** Files the copy never takes from the subject directory. */
function skipped(rel, subject) {
  if (/(^|\/)(\.venv|\.out|__pycache__|\.testguard)(\/|$)/.test(rel)) return true;
  if ((subject.config.counters ?? []).includes(rel)) return true;
  if (/(^|\/)node_modules(\/|$)/.test(rel)) return true;
  return false;
}

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
  const dir = mkdtempSync(join(scratchRoot ?? tmpdir(), `corpus-${subject.name}-`));
  cpSync(subject.dir, dir, { recursive: true, verbatimSymlinks: true, filter: (src) => { const rel = relative(subject.dir, src); return rel === '' || !skipped(rel, subject); } });
  writeFileSync(join(dir, '.gitignore'), `${IGNORE.join('\n')}\n`);
  linkDependencies(subject, dir, { nodeModules });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'subject');
  return dir;
}

export function linkDependencies(subject, dir, { nodeModules } = {}) {
  const { install: kind } = subject.config;
  if (kind === 'npm-workspace') {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    for (const link of subject.config.workspaceLinks ?? []) {
      const target = readlinkSync(join(subject.dir, 'node_modules', link));
      mkdirSync(dirname(join(dir, 'node_modules', link)), { recursive: true });
      symlinkSync(target, join(dir, 'node_modules', link));
      const resolved = realpathSync(join(dir, 'node_modules', link));
      if (!resolved.startsWith(realpathSync(dir))) throw new SubjectError(`${subject.name}: workspace link ${link} resolves outside the copy (${resolved})`);
    }
  } else if (kind === 'npm') {
    symlinkSync(nodeModules ?? join(subject.dir, 'node_modules'), join(dir, 'node_modules'), 'dir');
  }
}

/** A read-only copy of the subject's node_modules, and a listing to prove nothing wrote through it. */
export function readOnlyNodeModules(subject, root) {
  const copy = join(root, 'node_modules');
  cpSync(join(subject.dir, 'node_modules'), copy, { recursive: true, verbatimSymlinks: true });
  const lock = (p) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { for (const e of readdirSync(p)) lock(join(p, e)); chmodSync(p, 0o555); } else chmodSync(p, 0o444);
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
