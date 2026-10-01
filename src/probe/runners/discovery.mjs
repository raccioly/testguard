import { registerChild } from './lifecycle.mjs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, rmSync, statSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from '../../util/hash.mjs';
import { globToRegExp, walk } from '../../util/glob.mjs';
import { parseModuleSource, tokenizeModule } from '../imports.mjs';
import { terminateProcessTree, TIMEOUT_CLEANUP_WARNING } from './shared.mjs';

export const DISCOVERY_TIMEOUT_MS = 60_000;
export const MAX_DISCOVERY_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_DISCOVERY_FILES = 100_000;
export const MAX_DISCOVERY_PATH_BYTES = 4096;
export const MAX_DISCOVERY_CONFIG_BYTES = 1024 * 1024;
export const MAX_DISCOVERY_CONFIG_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_DISCOVERY_CONFIG_FILES = 4096;

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
  const packageBytes = readBoundedFile(join(root, 'package.json'), maxConfigBytes, 'discovery config package.json', { optional: true });
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
    const bytes = readBoundedFile(join(root, workspaceFile), maxConfigBytes, `discovery config ${workspaceFile}`);
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

const readBoundedFile = (path, maxBytes, label, { optional = false } = {}) => {
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
    if (stat.size > maxBytes) throw new DiscoveryError(`${label} exceeded ${maxBytes} bytes`);
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > maxBytes) throw new DiscoveryError(`${label} exceeded ${maxBytes} bytes`);
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

  return new Promise((resolvePromise, rejectPromise) => {
    const [command, ...args] = argv;
    let child;
    try {
      child = spawn(command, args, {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        env: { ...process.env, CI: '1', FORCE_COLOR: '0', ...env },
      });
    } catch (error) {
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

const existingConfigCandidate = (root, path) => {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw new DiscoveryError(`discovery config dependency is not readable: ${error.message}`, { cause: error });
  }
  if (stat.isSymbolicLink()) throw new DiscoveryError(`discovery config dependency is not readable: symbolic links are not allowed`);
  if (!stat.isFile()) return null;
  if (!inside(root, path)) throw new DiscoveryError(`discovery config dependency resolves outside the project: ${path}`);
  return path;
};

const resolveConfigReference = (root, fromPath, rawReference) => {
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
    const candidates = extname(base)
      ? [base]
      : [base, ...RESOLVABLE_CONFIG_EXTENSIONS.map((extension) => `${base}${extension}`),
        ...RESOLVABLE_CONFIG_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
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

const modulePackageRoot = (resolved) => {
  let current = dirname(resolved);
  while (dirname(current) !== current) {
    try {
      if (statSync(join(current, 'package.json')).isFile()) return current;
    } catch {}
    current = dirname(current);
  }
  return dirname(resolved);
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

/** Hash a package config helper and the static relative module closure of its entry. */
const hashModuleConfigDependency = (fromPath, fromLabel, specifier, { maxConfigBytes, maxTotalBytes, maxConfigFiles }) => {
  if (BUILTIN_MODULES.has(specifier)) return null;
  let entry;
  try {
    entry = createRequire(fromPath).resolve(specifier);
  } catch (error) {
    throw new DiscoveryError(`discovery config ${fromLabel} imports unresolved module ${specifier}: ${error.message}`, { cause: error });
  }
  if (!isAbsolute(entry)) return null;
  const packageRoot = modulePackageRoot(entry);
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
    if (seen.size > maxConfigFiles) throw new DiscoveryError(`module config dependency ${specifier} exceeded ${maxConfigFiles} files`);
    const bytes = readBoundedFile(path, maxConfigBytes, `module config dependency ${specifier}`);
    bytesRead += bytes.length;
    if (bytesRead > maxTotalBytes) throw new DiscoveryError(`module config dependency ${specifier} exceeded ${maxTotalBytes} bytes in total`);
    components.push({ path: relative(packageRoot, path).split(sep).join('/'), sha256: sha256(bytes) });
    if (!SCRIPT_CONFIG_EXTENSIONS.includes(extname(path))) continue;
    const { imports } = staticConfigReferences(path, bytes);
    for (const dependency of imports) {
      if (!dependency.startsWith('.')) continue; // Root lockfiles bind transitive package versions.
      const resolved = resolveRelativeModuleFile(path, dependency);
      if (!resolved) throw new DiscoveryError(`module config dependency ${specifier} imports missing file ${dependency}`);
      if (!inside(packageRoot, resolved)) throw new DiscoveryError(`module config dependency ${specifier} escapes its package: ${dependency}`);
      queued.push(resolved);
    }
  }
  components.sort((a, b) => a.path.localeCompare(b.path));
  return {
    entry: { path: `@module/${sha256(`${fromLabel}\0${specifier}`).slice(0, 20)}`, sha256: sha256(JSON.stringify(components)) },
    bytesRead,
  };
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
} = {}) {
  positiveInteger('maxConfigBytes', maxConfigBytes);
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
  const enqueue = (dependencyName) => {
    if (!seen.has(dependencyName) && !queued.includes(dependencyName)) queued.push(dependencyName);
  };
  let totalBytes = 0;
  while (queued.length > 0) {
    const name = queued.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const absolute = join(root, name);
    const bytes = readBoundedFile(absolute, maxConfigBytes, `discovery config ${name}`, { optional: true });
    if (bytes === null) continue; // Root candidates retain their absent sentinel.
    totalBytes += bytes.length;
    if (totalBytes > maxTotalBytes) throw new DiscoveryError(`discovery configs exceeded ${maxTotalBytes} bytes in total`);
    entries.set(name, { path: name, sha256: sha256(bytes) });
    const references = staticConfigReferences(name, bytes);
    for (const reference of references.paths) {
      for (const dependency of resolveConfigReference(root, absolute, reference)) {
        const dependencyName = relativeConfigPath(root, dependency);
        if (!configPath(dependencyName)) throw new DiscoveryError(`invalid discovery config dependency path: ${dependencyName}`);
        enqueue(dependencyName);
      }
    }
    for (const specifier of references.imports) {
      if (specifier.startsWith('.')) {
        for (const dependency of resolveConfigReference(root, absolute, specifier)) {
          const dependencyName = relativeConfigPath(root, dependency);
          if (!configPath(dependencyName)) throw new DiscoveryError(`invalid discovery config dependency path: ${dependencyName}`);
          enqueue(dependencyName);
        }
        continue;
      }
      const moduleDependency = hashModuleConfigDependency(absolute, name, specifier, { maxConfigBytes, maxTotalBytes, maxConfigFiles });
      if (!moduleDependency) continue;
      totalBytes += moduleDependency.bytesRead;
      if (totalBytes > maxTotalBytes) throw new DiscoveryError(`discovery configs exceeded ${maxTotalBytes} bytes in total`);
      entries.set(moduleDependency.entry.path, moduleDependency.entry);
    }
    queued.sort();
    if (seen.size + queued.length > maxConfigFiles) throw new DiscoveryError(`discovery config closure exceeded ${maxConfigFiles} files`);
  }
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Run a discovery command whose JSON reporter is directed to `{out}` in env. */
export async function runDiscoveryReportProcess(options) {
  const outFile = join(tmpdir(), `testguard-discovery-${randomBytes(8).toString('hex')}.json`);
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
  for (const reported of reportedFiles) {
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
    normalized.add(rel);
  }
  return [...normalized].sort();
}

const manifestPath = (file) => typeof file === 'string'
  && file.length > 0
  && !file.includes('\0')
  && !file.includes('\\')
  && !file.startsWith('/')
  && !file.split('/').some((part) => part === '' || part === '.' || part === '..')
  && Buffer.byteLength(file, 'utf8') <= MAX_DISCOVERY_PATH_BYTES;

/** A canonical, runner-bound snapshot of the exact native test universe. */
export function createDiscoveryManifest({ runner, version, files, configFiles = [], source = 'native' }) {
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
  const canonicalFiles = [...new Set(files)].sort();
  const canonicalConfigs = configFiles
    .map(({ path, sha256: contentHash }) => ({ path, sha256: contentHash }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (new Set(canonicalConfigs.map((entry) => entry.path)).size !== canonicalConfigs.length) {
    throw new DiscoveryError('a discovery manifest cannot contain duplicate config dependency paths');
  }
  const preimage = { schemaVersion: 1, runner: { name: runner, version }, source, files: canonicalFiles, configFiles: canonicalConfigs };
  return { ...preimage, testUniverseHash: sha256(JSON.stringify(preimage)) };
}
