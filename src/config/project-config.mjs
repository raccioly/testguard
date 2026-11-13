import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validate } from '../../spec/lib/validate.mjs';
import { sha256 } from '../util/hash.mjs';
import { repoRoot, isDirty } from '../git.mjs';
import { UsageError, PreconditionError } from '../probe/precondition-error.mjs';
import { parseCommandTemplate } from '../probe/runners/shared.mjs';
import { CONFIG_FILE } from './config-file.mjs';

/**
 * `testguard.config.json` (#301): how this project's tests run, so a plain
 * `testguard probe` — a hook, a CI line, an agent that never read the README —
 * runs them the way the maintainer does. Each key is a default for the flag
 * of the same meaning; nothing in the file can do what the flag could not.
 *
 * The file is read from the project directory as it is on disk (the working
 * tree): it is how the command runs, like the flags typed with it. Whether
 * the tree being probed agrees with it is the dirty rule's business
 * (`probe.mjs`): an uncommitted config refuses an implicit-HEAD probe exactly
 * as an uncommitted defender does.
 *
 * It is deliberately NOT a dependency input (`DEPENDENCY_MANIFEST_FILES`) nor
 * part of `run.instrument`: what feeds reuse is the resolved options, the same
 * whichever way they were given, so moving a flag into the file with the same
 * value carries every verdict forward, and changing a value refuses reuse
 * exactly as changing the flag does.
 */
export { CONFIG_FILE };

/** Each key and the flag it stands for. */
export const CONFIG_FLAGS = Object.freeze({
  runner: 'runner', runnerCmd: 'runner-cmd', python: 'python', nodeModules: 'node-modules', typecheck: 'typecheck',
  workers: 'workers', faultWorkers: 'fault-workers', confirm: 'confirm', budget: 'budget',
});

/** The keys an environment variable may also set; the variable wins over the file. */
export const CONFIG_ENV = Object.freeze({ python: 'TESTGUARD_PYTHON', nodeModules: 'TESTGUARD_NODE_MODULES', faultWorkers: 'TESTGUARD_FAULT_WORKERS' });

/** The commands that read the file: the ones that run tests, `claims --check-anchors`, and `status` (which reports it). */
export const CONFIG_COMMANDS = Object.freeze(['probe', 'admit', 'sweep', 'replay', 'claims', 'status']);

/** The keys a command applies; the others are left for the commands that take them. */
export function keyApplies(key, command, values = {}) {
  if (command === 'status') return false;
  if (command === 'claims') return Boolean(values['check-anchors']) && ['python', 'nodeModules', 'typecheck', 'budget'].includes(key);
  if (key === 'typecheck' || key === 'faultWorkers') return command === 'probe';
  return true;
}

/** One validation error, as a sentence that names the key. */
function describeError({ path, message }) {
  const key = path.split('/')[1];
  if (key === 'python' || key === 'nodeModules') return `"${key}" must be a relative path or a bare command, never absolute`;
  if (key === 'typecheck') return '"typecheck" must be true (the project\'s own tsc) or a command string';
  if (key === 'faultWorkers') return '"faultWorkers" must be a positive integer or "auto"';
  if (!key) return message;
  return `"${key}" ${message}`;
}

const isBare = (value) => !value.includes('/') && !value.includes('\\');

/**
 * The file in `projectDir`, validated, or undefined when there is none.
 * Malformed JSON, an unknown key, a wrong type or an unusable `runnerCmd` is
 * a usage error naming the key (exit 3); a path that leaves the repository is
 * the `path-outside-project` precondition (exit 2). `resolved` holds the path
 * values made absolute against the project directory, never the working
 * directory of the shell.
 */
export function readProjectConfig(projectDir, { source } = {}) {
  const path = join(projectDir, CONFIG_FILE);
  if (source === undefined && !existsSync(path)) return undefined;
  const text = source ?? readFileSync(path, 'utf8');
  let config;
  try { config = JSON.parse(text); }
  catch (error) { throw new UsageError(`${CONFIG_FILE}: not valid JSON (${error.message}); fix it, or pass --no-config to ignore it`); }
  // An unknown key is named before anything else: a misspelled option that
  // silently fell back to the default is the failure this file must not have.
  const known = new Set(['$schema', 'schemaVersion', ...Object.keys(CONFIG_FLAGS)]);
  const unknown = config && typeof config === 'object' && !Array.isArray(config) ? Object.keys(config).find((key) => !known.has(key)) : undefined;
  if (unknown !== undefined) throw new UsageError(`${CONFIG_FILE}: unknown key "${unknown}" (known: schemaVersion, ${Object.keys(CONFIG_FLAGS).join(', ')}); fix it, or pass --no-config to ignore it`);
  const result = validate('config', config);
  if (!result.ok) {
    const first = result.errors.find((e) => e.path !== '/') ?? result.errors[0];
    throw new UsageError(`${CONFIG_FILE}: ${describeError(first)}; fix it, or pass --no-config to ignore it`);
  }
  if (config.runnerCmd !== undefined) {
    try { parseCommandTemplate(config.runnerCmd); }
    catch (error) { throw new UsageError(`${CONFIG_FILE}: "runnerCmd" ${error.message}`); }
  }
  const resolved = {};
  let root;
  for (const key of ['python', 'nodeModules']) {
    const value = config[key];
    if (value === undefined) continue;
    if (key === 'python' && isBare(value)) { resolved.python = value; continue; }
    // By path text, never through links: a virtualenv's python is a symlink
    // out of the repository, and that is the commonest setup there is.
    const project = realpathSync(resolve(projectDir));
    if (root === undefined) {
      try { root = realpathSync(repoRoot(project)); } catch { root = project; }
    }
    const abs = resolve(project, value);
    const inside = relative(root, abs);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new PreconditionError(`${CONFIG_FILE}: "${key}" (${value}) resolves outside the repository at ${root}; a project setting must stay inside it (pass the path with --${CONFIG_FLAGS[key]} or ${CONFIG_ENV[key]} for this machine instead)`, 'path-outside-project');
    }
    resolved[key] = abs;
  }
  return { file: CONFIG_FILE, path, sha256: sha256(text), config, resolved };
}

/**
 * Does the working tree hold a version of the file git has not committed
 * (modified, added or untracked)? A command with no dirty rule of its own
 * (replay) says so instead of applying it silently. Unknown is dirty.
 */
export function configUncommitted(projectDir) {
  try { return isDirty(projectDir, [CONFIG_FILE]); } catch { return true; }
}

/** The keys the file sets, in schema order. */
export const configKeys = (config) => Object.keys(CONFIG_FLAGS).filter((key) => config[key] !== undefined);

/**
 * Merge the file under the command line: a key applies only where the flag
 * was not typed (`suppliedOptions`, never `values`, whose defaults always hold
 * something) and its environment variable is unset or empty. Returns the new
 * `values`, the keys taken from the file, the ones a flag or variable
 * overrode, and `faultWorkers`, which `resolveFaultWorkers` takes apart so
 * the evidence can say where the width came from.
 */
export function applyProjectConfig({ command, values, suppliedOptions = [], env = {}, loaded }) {
  const out = { ...values };
  const keys = [];
  const overridden = [];
  let faultWorkers;
  for (const key of configKeys(loaded.config)) {
    if (!keyApplies(key, command, values)) continue;
    const flag = CONFIG_FLAGS[key];
    if (suppliedOptions.includes(flag)) { overridden.push({ key, by: 'flag' }); continue; }
    const variable = CONFIG_ENV[key];
    if (variable && env[variable] !== undefined && env[variable] !== '') { overridden.push({ key, by: 'env' }); continue; }
    const value = loaded.resolved[key] ?? loaded.config[key];
    if (key === 'faultWorkers') faultWorkers = String(value);
    else if (key === 'typecheck') out.typecheck = value === true ? '' : value;
    else out[flag] = String(value);
    keys.push(key);
  }
  return { values: out, keys, overridden, ...(faultWorkers !== undefined ? { faultWorkers } : {}) };
}

/** What a document says about the file: which one, by hash, and the keys it supplied. */
export const configReport = (projectConfig) => projectConfig && {
  file: projectConfig.file,
  sha256: projectConfig.sha256,
  keys: projectConfig.keys,
  ...(projectConfig.overridden?.length ? { overridden: projectConfig.overridden } : {}),
};
