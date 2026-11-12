import { registerChild } from './lifecycle.mjs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync, rmSync, statSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { childScope, scratchRoot } from '../../scratch-dir.mjs';
import { sha256 } from '../../util/hash.mjs';
import { globToRegExp, walk } from '../../util/glob.mjs';
import { parseModuleSource, tokenizeModule } from '../imports.mjs';
import { resolveAliased } from '../rank.mjs';
import { terminateProcessTree, TIMEOUT_CLEANUP_WARNING } from './shared.mjs';

export const DISCOVERY_TIMEOUT_MS = 60_000;
export const MAX_DISCOVERY_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_DISCOVERY_FILES = 100_000;
export const MAX_DISCOVERY_PATH_BYTES = 4096;
export const MAX_DISCOVERY_CONFIG_BYTES = 1024 * 1024;
export const MAX_DISCOVERY_CONFIG_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_DISCOVERY_CONFIG_FILES = 4096;
// A data file a configuration names (a lockfile, a JSON list, a claims file)
// is hashed in chunks and never scanned for further references, so its size
// is bounded separately from the files that are scanned and held in memory.
export const MAX_DISCOVERY_HASH_BYTES = 256 * 1024 * 1024;
export const MAX_DISCOVERY_HASH_TOTAL_BYTES = 1024 * 1024 * 1024;
// An installed package is identified by its package.json name and version,
// never by its module files. The manifest read has its own bound, outside the
// project-file caps, and a manifest that cannot be read never fails the run.
const MAX_PACKAGE_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_LINK_HOPS = 40;
const PROJECT_FILE_HINT = 'TestGuard hashes every project file a test configuration imports, because it can change which tests exist; '
  + 'keep large data out of the configuration\'s import chain (import it from the tests instead), or split the module so the configuration imports only what it needs';

const SCRIPT_CONFIG_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'];
const RESOLVABLE_CONFIG_EXTENSIONS = [...SCRIPT_CONFIG_EXTENSIONS, '.json'];
const ABSENT_CONFIG_HASH = sha256('testguard:discovery-config:absent:v1');
const ALIAS_CONFIG_FILES = [
  'tsconfig.json',
  'jsconfig.json',
  ...['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].flatMap((ext) => [`vite.config.${ext}`, `vitest.config.${ext}`]),
];

const COMMON_CONFIG_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-workspace.yml',
  'lerna.json',
  'nx.json',
  'turbo.json',
  'rush.json',
  'workspace.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  ...ALIAS_CONFIG_FILES,
];

const CONVENTIONAL_CONFIG_BASENAMES = new Set([
  'package.json', 'pnpm-workspace.yaml', 'pnpm-workspace.yml', 'lerna.json', 'nx.json', 'turbo.json',
  'rush.json', 'workspace.json', 'pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'conftest.py',
]);

const isConventionalConfig = (path) => {
  const name = basename(path);
  return CONVENTIONAL_CONFIG_BASENAMES.has(name)
    || /^(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json$/.test(name)
    || /^(?:vite|vitest|jest|playwright)\.config\.(?:[cm]?[jt]sx?|json)$/.test(name)
    || /^vitest\.workspace\.(?:[cm]?[jt]s|json)$/.test(name);
};

const workspaceConfigFiles = (root, files, maxConfigBytes) => {
  const declared = [];
  const packageReal = realConfigPath(root, join(root, 'package.json'), 'discovery config package.json');
  const packageBytes = packageReal === null ? null : readBoundedFile(packageReal, maxConfigBytes, 'discovery config package.json', { hint: PROJECT_FILE_HINT });
  if (packageBytes !== null) {
    let pkg;
    try {
      pkg = JSON.parse(decodeUtf8(packageBytes, 'discovery config package.json'));
    } catch (error) {
      if (error instanceof DiscoveryError) throw error;
      throw new DiscoveryError(`discovery config package.json is not valid JSON: ${error.message}`, { cause: error });
    }
    const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    if (Array.isArray(workspaces)) declared.push(...workspaces);
  }

  for (const workspaceFile of files.filter((path) => !path.includes('/') && /^vitest\.workspace\./.test(path))) {
    const bytes = readBoundedFile(realpathSync(join(root, workspaceFile)), maxConfigBytes, `discovery config ${workspaceFile}`, { hint: PROJECT_FILE_HINT });
    const references = staticConfigReferences(workspaceFile, bytes);
    declared.push(...references.paths);
  }
  const patterns = declared.filter((pattern) => typeof pattern === 'string' && pattern.length > 0 && !pattern.startsWith('!'))
    .map((pattern) => pattern.replace(/^\.\//, '').replace(/\/$/, ''))
    .map((pattern) => globToRegExp(pattern));
  return files.filter((path) => {
    const directory = dirname(path).split(sep).join('/');
    return patterns.some((pattern) => pattern.test(directory) || pattern.test(path));
  });
};

export class DiscoveryError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'DiscoveryError';
  }
}

const positiveInteger = (name, value) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new DiscoveryError(`${name} must be a positive integer`);
};

const validateArgv = (argv) => {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== 'string' || part.length === 0 || part.includes('\0'))) {
    throw new DiscoveryError('native test discovery requires a non-empty argv of strings');
  }
};

const diagnostic = (stderr, stdout) => {
  const lines = `${stderr}\n${stdout}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const informative = lines.find((line) => /^error\b|error:/i.test(line) && !/^at\s/.test(line))
    ?? lines.find((line) => /failed|invalid|cannot|unexpected/i.test(line) && !/^at\s/.test(line));
  return (informative ?? lines.at(-1))?.slice(0, 1000);
};

const decodeUtf8 = (bytes, label) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new DiscoveryError(`${label} is not valid UTF-8`, { cause: error });
  }
};

const readBoundedFile = (path, maxBytes, label, { optional = false, hint } = {}) => {
  const exceeded = () => new DiscoveryError(`${label} exceeded ${maxBytes} bytes${hint ? `; ${hint}` : ''}`);
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw new DiscoveryError(`${label} is not readable: ${error.message}`, { cause: error });
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new DiscoveryError(`${label} is not a regular file`);
    if (stat.size > maxBytes) throw exceeded();
    // Reserve the observed file size, not the allowance for the largest report.
    // The extra byte detects growth; a full buffer grows within the same hard
    // ceiling so a concurrently appended suffix can never be silently dropped.
    let bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > maxBytes) throw exceeded();
      if (length === bytes.length) {
        const grown = Buffer.alloc(Math.min(maxBytes + 1, Math.max(4096, bytes.length * 2)));
        bytes.copy(grown, 0, 0, length);
        bytes = grown;
      }
    }
    if (length > maxBytes) throw exceeded();
    return bytes.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
};

/**
 * Run a runner's native listing command behind a hard time and output bound.
 * Any exceptional condition rejects discovery; callers must never substitute
 * a hand-written glob and accidentally turn an unknown test universe into a
 * successful one.
 */
export function runDiscoveryProcess({
  projectDir,
  argv,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
  maxOutputBytes = MAX_DISCOVERY_OUTPUT_BYTES,
  env = {},
  cleanupOnClose = false,
}) {
  validateArgv(argv);
  if (typeof projectDir !== 'string' || projectDir.length === 0 || projectDir.includes('\0')) throw new DiscoveryError('projectDir must be a non-empty path');
  positiveInteger('timeoutMs', timeoutMs);
  positiveInteger('maxOutputBytes', maxOutputBytes);
  if (env == null || typeof env !== 'object' || Array.isArray(env)) throw new DiscoveryError('discovery env must be an object');

  const scope = childScope();
  return new Promise((resolvePromise, rejectPromise) => {
    const [command, ...args] = argv;
    let child;
    try {
      child = spawn(command, args, {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        env: { ...process.env, CI: '1', FORCE_COLOR: '0', ...scope.env, ...env },
      });
      child.once('close', scope.dispose);
    } catch (error) {
      scope.dispose();
      rejectPromise(new DiscoveryError(`native test discovery could not start: ${error.message}`, { cause: error }));
      return;
    }

    registerChild(child, () => terminateProcessTree(child));
    const started = Date.now();
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let terminalError;
    let settled = false;
    let timer;

    const reject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    };
    const terminate = () => {
      terminateProcessTree(child);
    };
    const capture = (target) => (chunk) => {
      if (terminalError) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > maxOutputBytes) {
        terminalError = new DiscoveryError(`native test discovery output exceeded ${maxOutputBytes} bytes`);
        reject(terminalError);
        terminate();
        return;
      }
      target.push(bytes);
    };

    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.on('error', (error) => {
      terminalError ??= new DiscoveryError(`native test discovery could not start: ${error.message}`, { cause: error });
      reject(terminalError);
    });
    timer = setTimeout(() => {
      terminalError ??= new DiscoveryError(`native test discovery timeout of ${timeoutMs}ms exceeded; ${TIMEOUT_CLEANUP_WARNING}`);
      reject(terminalError);
      terminate();
    }, timeoutMs);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (cleanupOnClose) terminateProcessTree(child);
      if (settled) return;
      if (terminalError) {
        reject(terminalError);
        return;
      }
      let stdoutText;
      let stderrText;
      try {
        stdoutText = decodeUtf8(Buffer.concat(stdout), 'native test discovery stdout');
        stderrText = decodeUtf8(Buffer.concat(stderr), 'native test discovery stderr');
      } catch (error) {
        reject(error);
        return;
      }
      if (code !== 0) {
        const detail = diagnostic(stderrText, stdoutText);
        reject(new DiscoveryError(`native test discovery exited ${code ?? `on signal ${signal ?? 'unknown'}`}${detail ? `: ${detail}` : ''}`));
        return;
      }
      settled = true;
      resolvePromise({ stdout: stdoutText, stderr: stderrText, durationMs: Date.now() - started });
    });
  });
}

/** sha256 of a file read in fixed chunks, behind a byte bound; never held in memory whole. */
const hashBoundedFile = (path, maxBytes, label, hint) => {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw new DiscoveryError(`${label} is not readable: ${error.message}`, { cause: error });
  }
  try {
    if (!fstatSync(descriptor).isFile()) throw new DiscoveryError(`${label} is not a regular file`);
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(1024 * 1024);
    let length = 0;
    for (;;) {
      const read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      length += read;
      if (length > maxBytes) throw new DiscoveryError(`${label} exceeded ${maxBytes} bytes; ${hint}`);
      hash.update(chunk.subarray(0, read));
    }
    return { sha256: hash.digest('hex'), bytes: length };
  } finally {
    closeSync(descriptor);
  }
};

/** Read a runner-created JSON report only after enforcing a byte bound. */
export function readBoundedJsonFile(path, maxBytes = MAX_DISCOVERY_OUTPUT_BYTES) {
  positiveInteger('maxBytes', maxBytes);
  const bytes = readBoundedFile(path, maxBytes, 'native test discovery report');
  let text;
  try {
    text = decodeUtf8(bytes, 'native test discovery report');
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError(`native test discovery report is not valid JSON: ${error.message}`, { cause: error });
  }
}

const configPath = (path) => typeof path === 'string'
  && path.length > 0
  && !path.includes('\0')
  && !path.includes('\\')
  && !isAbsolute(path)
  && !path.split('/').some((part) => part === '' || part === '.' || part === '..');

const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

const relativeConfigPath = (root, path) => relative(root, path).split(sep).join('/');
const displayPath = (root, path) => (inside(root, path) ? relativeConfigPath(root, path) : path);

const LINK_CYCLE = Symbol('link cycle');
/** Where a dangling link chain points, lexically; null when `path` is not a link at all. */
const danglingLinkTarget = (path) => {
  let current = path;
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop++) {
    let stat;
    try { stat = lstatSync(current); } catch { return hop === 0 ? null : current; }
    if (!stat.isSymbolicLink()) return hop === 0 ? null : current;
    let parent;
    try { parent = realpathSync(dirname(current)); } catch { parent = dirname(current); }
    current = resolve(parent, readlinkSync(current));
  }
  return LINK_CYCLE;
};

/**
 * The real path of a configuration file. Symbolic links are followed while
 * the real path stays inside the project (#199): a committed link between two
 * project files is configuration like any other. A link that leaves the
 * project (itself, through a linked directory, or dangling) and a link cycle
 * are refused by name. Containment is decided on the real path, so a linked
 * directory cannot carry a plain file name out of the project either.
 * Returns null when no regular file is there.
 */
const realConfigPath = (root, path, label) => {
  let real;
  try {
    real = realpathSync(path);
  } catch (error) {
    if (error?.code === 'ELOOP') throw new DiscoveryError(`${label} is a symbolic link cycle: ${displayPath(root, path)}`, { cause: error });
    // A string literal longer than a path can be (a description, a long
    // message) names no file.
    if (error?.code === 'ENAMETOOLONG') return null;
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw new DiscoveryError(`${label} is not readable: ${error.message}`, { cause: error });
    const target = danglingLinkTarget(path);
    if (target === LINK_CYCLE) throw new DiscoveryError(`${label} is a symbolic link cycle: ${displayPath(root, path)}`);
    if (target && !inside(root, target)) throw new DiscoveryError(`${label} is a symbolic link that resolves outside the project: ${displayPath(root, path)} -> ${target}`);
    return null;
  }
  let stat;
  try {
    stat = statSync(real);
  } catch (error) {
    throw new DiscoveryError(`${label} is not readable: ${error.message}`, { cause: error });
  }
  // Strings in configs also name URL bases and separators: only an existing
  // file is a dependency, and only a file can leave the project.
  if (!stat.isFile()) return null;
  if (!inside(root, real)) throw new DiscoveryError(`${label} resolves outside the project: ${displayPath(root, path)}${real === path ? '' : ` -> ${real}`}`);
  return real;
};

const existingConfigCandidate = (root, path) => {
  const real = realConfigPath(root, path, `discovery config dependency ${displayPath(root, path)}`);
  if (!real) return null;
  // The name the configuration used, unless the path reached the project only
  // through an alias of its root (macOS /var -> /private/var).
  return inside(root, path) ? path : real;
};

const isDirectoryPath = (path) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

const resolveConfigReference = (root, fromPath, rawReference, { module = false } = {}) => {
  if (typeof rawReference !== 'string' || rawReference.length === 0 || rawReference.includes('\0')) return [];
  const reference = rawReference.replace(/[?#].*$/, '');
  if (!reference || /[*{}[\]]/.test(reference)) return [];

  let bases = [];
  if (reference.startsWith('<rootDir>/')) bases = [resolve(root, reference.slice('<rootDir>/'.length))];
  // Module specifiers are relative to their file, while runner options such
  // as Vitest `setupFiles: ['./test/setup.mjs']` are relative to the project.
  // Hash both existing interpretations; an extra dependency is conservative.
  else if (reference.startsWith('.')) bases = [resolve(dirname(fromPath), reference), resolve(root, reference)];
  else if (isAbsolute(reference)) bases = [resolve(reference)];
  else if (reference.includes('/') || extname(reference)) bases = [resolve(root, reference), resolve(dirname(fromPath), reference)];
  else return [];

  const resolved = new Set();
  for (const base of bases) {
    // Strings in executable configs also describe URLs and separators. Only
    // existing file candidates are dependencies; the boundary check follows
    // that distinction, while symlinks remain refused even when dangling.
    // A string that names a directory is a directory, not a module (#264):
    // `new URL('./src', import.meta.url)` names src/, and reading src/index.ts
    // as a config dependency followed the application's own imports with none
    // of its aliases. Only an import specifier resolves to an index file; a
    // directory string keeps the tsconfig/jsconfig a `references` entry means.
    const directoryString = !module && isDirectoryPath(base);
    const candidates = extname(base)
      ? [base]
      : [base, ...RESOLVABLE_CONFIG_EXTENSIONS.map((extension) => `${base}${extension}`),
        ...(directoryString ? [] : RESOLVABLE_CONFIG_EXTENSIONS.map((extension) => join(base, `index${extension}`))),
        join(base, 'tsconfig.json'), join(base, 'jsconfig.json')];
    for (const candidate of candidates) {
      const existing = existingConfigCandidate(root, candidate);
      if (existing) resolved.add(existing);
    }
  }
  return [...resolved];
};

const JSON_REFERENCE_KEYS = new Set([
  'extends', 'setupFiles', 'setupFilesAfterEnv', 'globalSetup', 'globalTeardown', 'testEnvironment',
  'testRunner', 'resolver', 'preset', 'projects', 'reporters', 'moduleNameMapper', 'transform',
  'snapshotResolver', 'watchPlugins',
]);

const jsonConfigReferences = (value) => {
  const references = new Set();
  const collectStrings = (item) => {
    if (typeof item === 'string') references.add(item);
    else if (Array.isArray(item)) for (const child of item) collectStrings(child);
    else if (item && typeof item === 'object') for (const child of Object.values(item)) collectStrings(child);
  };
  const visit = (item, parentKey) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child, parentKey);
      return;
    }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (JSON_REFERENCE_KEYS.has(key) || (key === 'path' && parentKey === 'references')) collectStrings(child);
      else visit(child, key);
    }
  };
  visit(value);
  return references;
};

const staticConfigReferences = (path, bytes) => {
  const text = decodeUtf8(bytes, `discovery config ${path}`);
  if (extname(path) === '.json') {
    try {
      return { paths: jsonConfigReferences(JSON.parse(text)), imports: new Set() };
    } catch (error) {
      throw new DiscoveryError(`discovery config ${path} is not valid JSON: ${error.message}`, { cause: error });
    }
  }
  if (!SCRIPT_CONFIG_EXTENSIONS.includes(extname(path))) return { paths: new Set(), imports: new Set() };
  let tokens;
  try {
    tokens = tokenizeModule(text);
  } catch (error) {
    throw new DiscoveryError(`discovery config ${path} cannot be scanned for static dependencies: ${error.message}`, { cause: error });
  }
  const paths = new Set(tokens.filter((token) => token.type === 'string').map((token) => token.value));
  let parsed;
  try {
    parsed = parseModuleSource(text);
  } catch (error) {
    throw new DiscoveryError(`discovery config ${path} cannot be scanned for static dependencies: ${error.message}`, { cause: error });
  }
  const imports = new Set(parsed.runtime);
  for (const specifier of imports) paths.delete(specifier);
  return { paths, imports };
};

const BUILTIN_MODULES = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/** `@scope/pkg/sub` -> { name: '@scope/pkg', subpath: './sub' }; null for anything that is not a package name. */
const packageSpecifier = (specifier) => {
  if (!specifier || /^[./#]/.test(specifier) || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) return null;
  const parts = specifier.split('/');
  const take = specifier.startsWith('@') ? 2 : 1;
  if (parts.length < take || parts.slice(0, take).some((part) => !part || part === '.' || part === '..')) return null;
  const rest = parts.slice(take).join('/');
  return { name: parts.slice(0, take).join('/'), subpath: rest ? `./${rest}` : '.' };
};

const isDirectory = (path) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};
const installed = (path) => path.split(sep).includes('node_modules');

/** Node's own lookup: the nearest `node_modules/<name>` from the importing file's directory upward. */
const findPackageDir = (fromPath, name) => {
  for (let at = dirname(fromPath); ; at = dirname(at)) {
    if (basename(at) !== 'node_modules') {
      const candidate = join(at, 'node_modules', ...name.split('/'));
      if (isDirectory(candidate)) return candidate;
    }
    if (dirname(at) === at) return null;
  }
};

/** The package directory an installed module file belongs to: the directory directly under a node_modules (or its @scope). */
const installedPackageDir = (file) => {
  for (let at = dirname(file); dirname(at) !== at; at = dirname(at)) {
    const parent = dirname(at);
    if (basename(parent) === 'node_modules') return at;
    if (basename(parent).startsWith('@') && basename(dirname(parent)) === 'node_modules') return at;
  }
  return null;
};

/** A package manifest, parsed; {} when it is missing, oversized or malformed. Never throws. */
const readPackageManifest = (dir, maxBytes = MAX_PACKAGE_MANIFEST_BYTES) => {
  try {
    const bytes = readBoundedFile(join(realpathSync(dir), 'package.json'), maxBytes, 'package manifest', { optional: true });
    const pkg = bytes === null ? null : JSON.parse(decodeUtf8(bytes, 'package manifest'));
    return pkg && typeof pkg === 'object' && !Array.isArray(pkg) ? pkg : {};
  } catch {
    return {};
  }
};

const EXPORT_CONDITIONS = ['import', 'node', 'module', 'default', 'require'];
const exportTarget = (value) => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(exportTarget).find(Boolean) ?? null;
  if (value && typeof value === 'object') {
    for (const condition of EXPORT_CONDITIONS) {
      const target = condition in value ? exportTarget(value[condition]) : null;
      if (target) return target;
    }
  }
  return null;
};
const exportsTarget = (exportsField, subpath) => {
  if (exportsField == null) return null;
  const keyed = typeof exportsField === 'object' && !Array.isArray(exportsField) && Object.keys(exportsField).some((key) => key.startsWith('.'));
  if (!keyed) return subpath === '.' ? exportTarget(exportsField) : null;
  if (Object.hasOwn(exportsField, subpath)) return exportTarget(exportsField[subpath]);
  for (const [key, value] of Object.entries(exportsField)) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const [prefix, suffix] = [key.slice(0, star), key.slice(star + 1)];
    if (subpath.length < prefix.length + suffix.length || !subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const target = exportTarget(value);
    if (target) return target.replaceAll('*', subpath.slice(prefix.length, subpath.length - suffix.length));
  }
  return null;
};

/** The file a linked (source, not installed) package exposes at `subpath`. */
const linkedPackageEntry = (dir, subpath, pkg) => {
  const target = exportsTarget(pkg.exports, subpath)
    ?? (subpath === '.' ? (typeof pkg.module === 'string' ? pkg.module : typeof pkg.main === 'string' ? pkg.main : './index') : subpath);
  return resolveRelativeModuleFile(join(dir, 'package.json'), target.startsWith('.') ? target : `./${target}`);
};

const resolveRelativeModuleFile = (fromPath, specifier) => {
  const base = resolve(dirname(fromPath), specifier.replace(/[?#].*$/, ''));
  const candidates = extname(base)
    ? [base]
    : [base, ...RESOLVABLE_CONFIG_EXTENSIONS.map((extension) => `${base}${extension}`),
      ...RESOLVABLE_CONFIG_EXTENSIONS.map((extension) => join(base, `index${extension}`))];
  return candidates.find((candidate) => {
    try { return lstatSync(candidate).isFile(); } catch { return false; }
  });
};

const moduleEntryPath = (fromLabel, specifier) => `@module/${sha256(`${fromLabel}\0${specifier}`).slice(0, 20)}`;

/** An installed package: its name and resolved version, never its module files (#278). */
const installedPackageEntry = (fromLabel, specifier, name, dir) => {
  const pkg = readPackageManifest(dir);
  const identity = {
    package: typeof pkg.name === 'string' ? pkg.name : name,
    version: typeof pkg.version === 'string' ? pkg.version : null,
  };
  return { entry: { path: moduleEntryPath(fromLabel, specifier), sha256: sha256(JSON.stringify(identity)) }, bytesRead: 0 };
};

/**
 * Source linked from outside the project (a `link:`/`file:` dependency, or a
 * workspace package beyond a nested project's root): the static relative
 * closure of its entry, under the project-file caps, as one entry.
 */
const linkedSourceEntry = (fromLabel, specifier, packageRoot, entry, { maxConfigBytes, maxTotalBytes, maxConfigFiles }) => {
  const queued = [entry];
  const packageJson = join(packageRoot, 'package.json');
  try { if (statSync(packageJson).isFile()) queued.push(packageJson); } catch {}
  const seen = new Set();
  const components = [];
  let bytesRead = 0;
  while (queued.length > 0) {
    const path = queued.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    if (seen.size > maxConfigFiles) throw new DiscoveryError(`linked config dependency ${specifier} exceeded ${maxConfigFiles} files; ${PROJECT_FILE_HINT}`);
    const bytes = readBoundedFile(path, maxConfigBytes, `linked config dependency ${specifier} file ${relative(packageRoot, path).split(sep).join('/')}`, { hint: PROJECT_FILE_HINT });
    bytesRead += bytes.length;
    if (bytesRead > maxTotalBytes) throw new DiscoveryError(`linked config dependency ${specifier} exceeded ${maxTotalBytes} bytes in total; ${PROJECT_FILE_HINT}`);
    components.push({ path: relative(packageRoot, path).split(sep).join('/'), sha256: sha256(bytes) });
    if (!SCRIPT_CONFIG_EXTENSIONS.includes(extname(path))) continue;
    const { imports } = staticConfigReferences(path, bytes);
    for (const dependency of imports) {
      if (!dependency.startsWith('.')) continue; // Its own package imports are resolved where they are installed.
      const resolved = resolveRelativeModuleFile(path, dependency);
      if (!resolved) throw new DiscoveryError(`linked config dependency ${specifier} imports missing file ${dependency}`);
      if (!inside(packageRoot, resolved)) throw new DiscoveryError(`linked config dependency ${specifier} escapes its package: ${dependency}`);
      queued.push(resolved);
    }
  }
  components.sort((a, b) => a.path.localeCompare(b.path));
  return { entry: { path: moduleEntryPath(fromLabel, specifier), sha256: sha256(JSON.stringify(components)) }, bytesRead };
};

/**
 * A bare import in a configuration file. Three outcomes, decided by where
 * the package really lives, never by its size:
 * - installed (its real path is under a node_modules directory, including
 *   pnpm's store and a scratch tree's link to the source install): recorded
 *   by name and version. The lockfile and manifests bind it as well.
 * - linked source inside the project (a workspace package): `follow` names
 *   its entry, which is then hashed like a relative import.
 * - linked source outside the project: its bounded relative closure.
 */
const hashModuleConfigDependency = (fromPath, fromLabel, specifier, limits, root) => {
  if (BUILTIN_MODULES.has(specifier)) return null;
  const parsed = packageSpecifier(specifier);
  const dir = parsed ? findPackageDir(fromPath, parsed.name) : null;
  if (dir) {
    const real = realpathSync(dir);
    if (installed(real)) return installedPackageEntry(fromLabel, specifier, parsed.name, real);
    const pkg = readPackageManifest(real, limits.maxConfigBytes);
    const entry = linkedPackageEntry(real, parsed.subpath, pkg);
    if (!entry) throw new DiscoveryError(`discovery config ${fromLabel} imports linked package ${specifier}, whose entry cannot be resolved in ${displayPath(root, real)}`);
    const realEntry = realpathSync(entry);
    if (inside(root, realEntry)) return { follow: [realEntry, ...(inside(root, real) ? [join(real, 'package.json')] : [])] };
    return linkedSourceEntry(fromLabel, specifier, real, realEntry, limits);
  }
  // Not under any node_modules directory: package.json `imports` (#name), a
  // self-reference, NODE_PATH. Node's resolver decides; it never reads files.
  let resolved;
  try {
    resolved = createRequire(fromPath).resolve(specifier);
  } catch (error) {
    throw new DiscoveryError(`discovery config ${fromLabel} imports unresolved module ${specifier}: ${error.message}`, { cause: error });
  }
  if (!isAbsolute(resolved)) return null;
  const real = realpathSync(resolved);
  if (installed(real)) {
    const packageDir = installedPackageDir(real) ?? dirname(real);
    return installedPackageEntry(fromLabel, specifier, parsed?.name ?? specifier, packageDir);
  }
  if (inside(root, real)) return { follow: [real] };
  return linkedSourceEntry(fromLabel, specifier, dirname(real), real, limits);
};

/**
 * Hash the bounded conventional inputs that can change native discovery.
 *
 * Root candidates carry an explicit absent sentinel, so creating a config
 * invalidates a prior universe even when the listed files happen to stay the
 * same. Existing nested workspace configs and the static local dependency
 * closure of every config are included as well. Dynamic dependencies are
 * still evaluated by the runner, but they can never disappear from this hash
 * merely because they live in an imported helper or setup file.
 */
export function hashDiscoveryConfigs(projectDir, runnerConfigFiles = [], {
  maxConfigBytes = MAX_DISCOVERY_CONFIG_BYTES,
  maxTotalBytes = MAX_DISCOVERY_CONFIG_TOTAL_BYTES,
  maxConfigFiles = MAX_DISCOVERY_CONFIG_FILES,
  maxHashBytes = MAX_DISCOVERY_HASH_BYTES,
  maxHashTotalBytes = MAX_DISCOVERY_HASH_TOTAL_BYTES,
} = {}) {
  positiveInteger('maxConfigBytes', maxConfigBytes);
  positiveInteger('maxHashBytes', maxHashBytes);
  positiveInteger('maxHashTotalBytes', maxHashTotalBytes);
  positiveInteger('maxTotalBytes', maxTotalBytes);
  positiveInteger('maxConfigFiles', maxConfigFiles);
  if (typeof projectDir !== 'string' || projectDir.length === 0 || projectDir.includes('\0')) throw new DiscoveryError('projectDir must be a non-empty path');
  if (!Array.isArray(runnerConfigFiles) || runnerConfigFiles.some((path) => !configPath(path))) {
    throw new DiscoveryError('discovery config candidates must be normalized project-relative paths');
  }
  let root;
  try {
    root = realpathSync(resolve(projectDir));
  } catch (error) {
    throw new DiscoveryError(`cannot validate discovery project root: ${error.message}`, { cause: error });
  }
  const rootCandidates = [...new Set([...COMMON_CONFIG_FILES, ...runnerConfigFiles])].sort();
  let discovered;
  try {
    const conventional = walk(root).filter(isConventionalConfig);
    discovered = workspaceConfigFiles(root, conventional, maxConfigBytes);
    if (runnerConfigFiles.includes('conftest.py')) {
      discovered.push(...conventional.filter((path) => basename(path) === 'conftest.py'));
    }
    discovered = [...new Set(discovered)].sort();
  } catch (error) {
    throw new DiscoveryError(`cannot enumerate discovery configs: ${error.message}`, { cause: error });
  }
  const queued = [...new Set([...rootCandidates, ...discovered])].sort();
  if (queued.length > maxConfigFiles) throw new DiscoveryError(`discovery config closure exceeded ${maxConfigFiles} files`);

  const entries = new Map(rootCandidates.map((path) => [path, { path, sha256: ABSENT_CONFIG_HASH }]));
  const seen = new Set();
  const contentByReal = new Map();
  const enqueue = (dependencyName) => {
    if (!seen.has(dependencyName) && !queued.includes(dependencyName)) queued.push(dependencyName);
  };
  const enqueuePath = (dependency) => {
    const dependencyName = relativeConfigPath(root, dependency);
    if (!configPath(dependencyName)) throw new DiscoveryError(`invalid discovery config dependency path: ${dependencyName}`);
    enqueue(dependencyName);
  };
  let totalBytes = 0;
  let hashedBytes = 0;
  while (queued.length > 0) {
    const name = queued.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const absolute = join(root, name);
    const real = realConfigPath(root, absolute, `discovery config ${name}`);
    if (real === null) continue; // Root candidates retain their absent sentinel.
    // Two names for one file (a link inside the project) are both recorded;
    // the file is read and followed once, which also ends any link loop.
    if (contentByReal.has(real)) {
      entries.set(name, { path: name, sha256: contentByReal.get(real) });
      continue;
    }
    // A large file that is not a module is data: hashed, not scanned. A module
    // must be scanned for what it imports, so its scan bound stays.
    const script = [real, name].some((path) => SCRIPT_CONFIG_EXTENSIONS.includes(extname(path)));
    if (!script && statSync(real).size > maxConfigBytes) {
      const hashed = hashBoundedFile(real, maxHashBytes, `discovery config ${name}`, PROJECT_FILE_HINT);
      hashedBytes += hashed.bytes;
      if (hashedBytes > maxHashTotalBytes) throw new DiscoveryError(`discovery configs exceeded ${maxHashTotalBytes} hashed bytes in total at ${name}; ${PROJECT_FILE_HINT}`);
      contentByReal.set(real, hashed.sha256);
      entries.set(name, { path: name, sha256: hashed.sha256 });
      continue;
    }
    const bytes = readBoundedFile(real, maxConfigBytes, `discovery config ${name}`, { hint: PROJECT_FILE_HINT });
    totalBytes += bytes.length;
    if (totalBytes > maxTotalBytes) throw new DiscoveryError(`discovery configs exceeded ${maxTotalBytes} bytes in total at ${name}; ${PROJECT_FILE_HINT}`);
    contentByReal.set(real, sha256(bytes));
    entries.set(name, { path: name, sha256: contentByReal.get(real) });
    const references = staticConfigReferences(name, bytes);
    // Node resolves a module's imports from its real location; strings are
    // also tried from where the configuration named the file.
    const fromPaths = real === absolute ? [absolute] : [real, absolute];
    for (const reference of references.paths) {
      for (const fromPath of fromPaths) for (const dependency of resolveConfigReference(root, fromPath, reference)) enqueuePath(dependency);
    }
    for (const specifier of references.imports) {
      if (specifier.startsWith('.')) {
        for (const dependency of resolveConfigReference(root, real, specifier, { module: true })) enqueuePath(dependency);
        continue;
      }
      // A specifier the project's own alias configuration maps (`@/errors` in
      // a setup file) is project source, not a package: follow it there. One
      // the alias maps to nothing is not followed here; the import closure
      // (rule 8) records it as indeterminate instead of refusing the run (#264).
      const aliased = resolveAliased(root, real, specifier);
      if (aliased.aliased) {
        for (const file of aliased.files) if (inside(root, file)) enqueuePath(file);
        continue;
      }
      const moduleDependency = hashModuleConfigDependency(real, name, specifier, { maxConfigBytes, maxTotalBytes, maxConfigFiles }, root);
      if (!moduleDependency) continue;
      for (const dependency of moduleDependency.follow ?? []) enqueuePath(dependency);
      if (!moduleDependency.entry) continue;
      totalBytes += moduleDependency.bytesRead;
      if (totalBytes > maxTotalBytes) throw new DiscoveryError(`discovery configs exceeded ${maxTotalBytes} bytes in total at ${specifier}; ${PROJECT_FILE_HINT}`);
      entries.set(moduleDependency.entry.path, moduleDependency.entry);
    }
    queued.sort();
    if (seen.size + queued.length > maxConfigFiles) throw new DiscoveryError(`discovery config closure exceeded ${maxConfigFiles} files at ${name}; ${PROJECT_FILE_HINT}`);
  }
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Run a discovery command whose JSON reporter is directed to `{out}` in env. */
export async function runDiscoveryReportProcess(options) {
  const outFile = join(scratchRoot(), `testguard-discovery-${randomBytes(8).toString('hex')}.json`);
  const env = Object.fromEntries(Object.entries(options.env ?? {}).map(([key, value]) => [key, String(value).replaceAll('{out}', outFile)]));
  try {
    const processResult = await runDiscoveryProcess({ ...options, env });
    return { ...processResult, report: readBoundedJsonFile(outFile, options.maxOutputBytes) };
  } finally {
    rmSync(outFile, { force: true });
  }
}

const outside = (root, path) => {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};

/**
 * Validate runner-reported paths against both lexical and real project roots.
 * Output is relative to the canonical project root. That both rejects symlink
 * escapes and removes platform aliases such as macOS `/var` → `/private/var`
 * from the identity being hashed.
 */
export function normalizeDiscoveredFiles(projectDir, reportedFiles, {
  maxFiles = MAX_DISCOVERY_FILES,
  maxPathBytes = MAX_DISCOVERY_PATH_BYTES,
} = {}) {
  positiveInteger('maxFiles', maxFiles);
  positiveInteger('maxPathBytes', maxPathBytes);
  if (typeof projectDir !== 'string' || projectDir.length === 0 || projectDir.includes('\0')) throw new DiscoveryError('projectDir must be a non-empty path');
  if (!Array.isArray(reportedFiles)) throw new DiscoveryError('native test discovery must return an array of file paths');
  if (reportedFiles.length > maxFiles) throw new DiscoveryError(`native test discovery returned more than ${maxFiles} files`);

  const root = resolve(projectDir);
  let realRoot;
  try {
    realRoot = realpathSync(root);
    if (!statSync(realRoot).isDirectory()) throw new Error('project path is not a directory');
  } catch (error) {
    throw new DiscoveryError(`cannot validate discovery project root: ${error.message}`, { cause: error });
  }

  const normalized = new Set();
  for (const reported of reportedFiles) normalized.add(normalizeOne(root, realRoot, reported, maxPathBytes));
  return [...normalized].sort();
}

const MAX_PROJECT_NAME_BYTES = 1024;
const projectName = (name) => typeof name === 'string'
  && name.length > 0
  && !name.includes('\0')
  && Buffer.byteLength(name, 'utf8') <= MAX_PROJECT_NAME_BYTES;

/**
 * Like normalizeDiscoveredFiles, for a listing that also names the project
 * each file belongs to (Vitest `test.projects`). One file may be listed under
 * several projects; its projects come back sorted and unique.
 */
export function normalizeDiscoveredEntries(projectDir, entries, {
  maxFiles = MAX_DISCOVERY_FILES,
  maxPathBytes = MAX_DISCOVERY_PATH_BYTES,
} = {}) {
  if (!Array.isArray(entries) || entries.some((entry) => entry == null || typeof entry !== 'object')) {
    throw new DiscoveryError('native test discovery must return an array of file entries');
  }
  if (entries.some((entry) => entry.project !== undefined && !projectName(entry.project))) {
    throw new DiscoveryError('native test discovery returned a malformed project name');
  }
  const files = normalizeDiscoveredFiles(projectDir, entries.map((entry) => entry.file), { maxFiles, maxPathBytes });
  const root = resolve(projectDir);
  const realRoot = realpathSync(root);
  const projects = new Map();
  for (const entry of entries) {
    if (entry.project === undefined) continue;
    const file = normalizeOne(root, realRoot, entry.file, maxPathBytes);
    if (!projects.has(file)) projects.set(file, new Set());
    projects.get(file).add(entry.project);
  }
  return {
    files,
    projects: Object.fromEntries([...projects].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([file, names]) => [file, [...names].sort()])),
  };
}

const normalizeOne = (root, realRoot, reported, maxPathBytes) => {
  if (typeof reported !== 'string' || reported.length === 0 || reported.includes('\0')) {
    throw new DiscoveryError('native test discovery returned a malformed file path');
  }
  const absolute = isAbsolute(reported) ? resolve(reported) : resolve(root, reported);

  let real;
  let stat;
  try {
    real = realpathSync(absolute);
    stat = statSync(real);
  } catch (error) {
    throw new DiscoveryError(`native test discovery path does not exist: ${reported}`, { cause: error });
  }
  if (outside(realRoot, real)) throw new DiscoveryError(`native test discovery path resolves outside the project: ${reported}`);
  if (!stat.isFile()) throw new DiscoveryError(`native test discovery path is not a file: ${reported}`);

  const rel = relative(realRoot, real).split(sep).join('/');
  if (!rel || Buffer.byteLength(rel, 'utf8') > maxPathBytes) {
    throw new DiscoveryError(`native test discovery path exceeds ${maxPathBytes} bytes: ${reported}`);
  }
  return rel;
};

const manifestPath = (file) => typeof file === 'string'
  && file.length > 0
  && !file.includes('\0')
  && !file.includes('\\')
  && !file.startsWith('/')
  && !file.split('/').some((part) => part === '' || part === '.' || part === '..')
  && Buffer.byteLength(file, 'utf8') <= MAX_DISCOVERY_PATH_BYTES;

/**
 * A canonical, runner-bound snapshot of the exact native test universe.
 * `projects` maps a file to the runner projects that list it (Vitest
 * `test.projects`); a file runs under each of them, so membership is part of
 * the universe and of its hash. Without projects the preimage is unchanged.
 */
export function createDiscoveryManifest({ runner, version, files, configFiles = [], source = 'native', projects }) {
  if (typeof runner !== 'string' || runner.length === 0 || typeof version !== 'string' || version.length === 0) {
    throw new DiscoveryError('a discovery manifest requires non-empty runner and version strings');
  }
  if (!Array.isArray(files) || files.length > MAX_DISCOVERY_FILES || files.some((file) => !manifestPath(file))) {
    throw new DiscoveryError('a discovery manifest requires normalized project-relative file paths');
  }
  if (!Array.isArray(configFiles) || configFiles.some((entry) => entry == null
    || typeof entry !== 'object'
    || !configPath(entry.path)
    || !/^[0-9a-f]{64}$/.test(entry.sha256))) {
    throw new DiscoveryError('a discovery manifest requires valid config dependency hashes');
  }
  if (typeof source !== 'string' || source.length === 0) throw new DiscoveryError('a discovery manifest requires a source');
  if (projects !== undefined && (projects === null || typeof projects !== 'object' || Array.isArray(projects))) {
    throw new DiscoveryError('a discovery manifest requires project membership as an object');
  }
  const canonicalFiles = [...new Set(files)].sort();
  const fileSet = new Set(canonicalFiles);
  const membership = Object.entries(projects ?? {}).map(([file, names]) => {
    if (!fileSet.has(file)) throw new DiscoveryError(`a discovery manifest names projects for a file it does not list: ${file}`);
    if (!Array.isArray(names) || names.length === 0 || names.some((projectNameValue) => !projectName(projectNameValue))) {
      throw new DiscoveryError(`a discovery manifest requires non-empty project names for ${file}`);
    }
    return [file, [...new Set(names)].sort()];
  }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalConfigs = configFiles
    .map(({ path, sha256: contentHash }) => ({ path, sha256: contentHash }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (new Set(canonicalConfigs.map((entry) => entry.path)).size !== canonicalConfigs.length) {
    throw new DiscoveryError('a discovery manifest cannot contain duplicate config dependency paths');
  }
  const preimage = {
    schemaVersion: 1,
    runner: { name: runner, version },
    source,
    files: canonicalFiles,
    configFiles: canonicalConfigs,
    ...(membership.length ? { projects: Object.fromEntries(membership) } : {}),
  };
  return { ...preimage, testUniverseHash: sha256(JSON.stringify(preimage)) };
}
