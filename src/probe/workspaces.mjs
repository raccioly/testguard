/**
 * Workspace packages: the packages of a monorepo that a bare specifier
 * (`@scope/pkg`) reaches through a link in node_modules
 * (`node_modules/@scope/pkg -> ../../packages/pkg`) instead of an install.
 *
 * Two consumers, one reading. The import closure (#268) follows such a
 * specifier into the package's source, because it is code the defenders run;
 * the scratch worktree (#263) points the link at its own copy of the package,
 * because otherwise the defenders run the ORIGINAL checkout's copy and a fault
 * applied in the scratch tree is never executed.
 *
 * A package is a workspace package when the repository declares it — root
 * package.json `workspaces` (an array or `{ packages }`, as npm, yarn and bun
 * write it) or `pnpm-workspace.yaml` `packages` — or when a node_modules entry
 * is a symlink whose target is inside the repository and not itself inside a
 * node_modules directory (a `file:` or `link:` dependency). Never by "the
 * realpath is inside the repository": every installed package is, under the
 * repository's own node_modules.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_PATTERN_DEPTH = 6;
const MAX_PACKAGES = 4096;

const isDir = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const real = (path) => { try { return realpathSync(path); } catch { return null; } };

/** Is `path` inside `root` (or `root` itself)? Lexical. */
export function within(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Inside `root` and not under any node_modules directory: source, not an install. */
export function withinSource(root, path) {
  return within(root, path) && !relative(root, path).split(sep).includes('node_modules');
}

/** The repository `dir` belongs to: the nearest ancestor holding `.git` (a directory or a worktree's file), else `dir`. */
export function repositoryRoot(dir) {
  for (let at = resolve(dir); ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return at;
    if (dirname(at) === at) return resolve(dir);
  }
}

/** `@scope/pkg/sub` → { name: '@scope/pkg', subpath: './sub' }; null for a specifier that is not a package name. */
export function packageSpecifier(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) return null;
  const parts = specifier.split('/');
  const take = specifier.startsWith('@') ? 2 : 1;
  if (parts.length < take || parts.slice(0, take).some((part) => !part)) return null;
  const rest = parts.slice(take).join('/');
  return { name: parts.slice(0, take).join('/'), subpath: rest ? `./${rest}` : '.' };
}

/** The `packages:` list of a pnpm-workspace.yaml, read without a YAML library (block and flow sequences). */
export function pnpmWorkspacePatterns(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (at === -1) return [];
  const unquote = (value) => value.trim().replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
  const flow = /^packages\s*:\s*\[(.*)\]\s*$/.exec(lines[at]);
  if (flow) return flow[1].split(',').map(unquote).filter(Boolean);
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (!item) break;
    out.push(unquote(item[1]));
  }
  return out.filter(Boolean);
}

/** Directories a workspace pattern (`packages/*`, `apps/**`, `libs/core`) names under `base`. */
function expandPattern(base, pattern) {
  const segments = pattern.replace(/^\.\//, '').replace(/\/+$/, '').split('/').filter((s) => s && s !== '.');
  let dirs = [base];
  for (const segment of segments) {
    const next = [];
    for (const dir of dirs) {
      if (segment === '**') {
        const visit = (at, depth) => {
          next.push(at);
          if (depth >= MAX_PATTERN_DEPTH) return;
          for (const child of childDirs(at)) visit(child, depth + 1);
        };
        visit(dir, 0);
      } else if (segment.includes('*')) {
        const re = new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
        for (const child of childDirs(dir)) if (re.test(child.slice(dir.length + 1))) next.push(child);
      } else if (isDir(join(dir, segment))) next.push(join(dir, segment));
    }
    dirs = next;
    if (dirs.length > MAX_PACKAGES) break;
  }
  return dirs;
}

function childDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.name !== 'node_modules' && !entry.name.startsWith('.') && (entry.isDirectory() || (entry.isSymbolicLink() && isDir(join(dir, entry.name)))))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/** The workspace patterns declared at `dir` (package.json `workspaces`, pnpm-workspace.yaml). */
function declaredPatterns(dir) {
  const patterns = [];
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const list = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    if (Array.isArray(list)) patterns.push(...list.filter((p) => typeof p === 'string'));
  } catch {}
  for (const name of ['pnpm-workspace.yaml', 'pnpm-workspace.yml']) {
    try { patterns.push(...pnpmWorkspacePatterns(readFileSync(join(dir, name), 'utf8'))); } catch {}
  }
  return patterns;
}

/**
 * Every declared workspace package visible from `dir`: the declarations at
 * `dir` and at each ancestor up to the repository root. name → absolute real
 * directory. A negated pattern (`!packages/legacy`) removes what it names.
 */
export function workspacePackages(dir, repo = repositoryRoot(dir)) {
  const packages = new Map();
  for (let at = resolve(dir); within(repo, at); at = dirname(at)) {
    const patterns = declaredPatterns(at);
    const excluded = new Set(patterns.filter((p) => p.startsWith('!')).flatMap((p) => expandPattern(at, p.slice(1))).map(real).filter(Boolean));
    for (const pattern of patterns.filter((p) => !p.startsWith('!'))) {
      for (const candidate of expandPattern(at, pattern)) {
        const path = real(candidate);
        if (!path || excluded.has(path) || !existsSync(join(path, 'package.json'))) continue;
        let name;
        try { name = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).name; } catch { continue; }
        if (typeof name === 'string' && name && !packages.has(name)) packages.set(name, path);
        if (packages.size >= MAX_PACKAGES) return packages;
      }
    }
    if (at === repo || dirname(at) === at) break;
  }
  return packages;
}

/**
 * Where a node_modules symlink at `link` points, as source in `repo`: its
 * lexical target (what it names relative to where it sits, which maps into
 * THIS checkout even when node_modules is itself borrowed from another) and
 * its real target. Each kept only when it is repository source. Empty for a
 * real directory (an install) and for a link that leaves the repository.
 */
export function linkedSourceDirs(link, repo) {
  let stat;
  try { stat = lstatSync(link); } catch { return null; }
  if (!stat.isSymbolicLink()) return [];
  const out = new Set();
  try {
    const lexical = resolve(dirname(link), readlinkSync(link));
    if (withinSource(repo, lexical) && isDir(lexical)) out.add(real(lexical) ?? lexical);
  } catch {}
  const target = real(link);
  if (target && withinSource(repo, target)) out.add(target);
  return [...out];
}
