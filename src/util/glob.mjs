import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// Dependency and tool directories. The Python entries are not cosmetic: a
// virtualenv inside the project holds thousands of `test_*.py` files belonging
// to installed packages, and without skipping it every one of them would be
// collected as a test file of the project under probe.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.testguard',
  '__pycache__', '.venv', 'venv', 'site-packages', '.tox', '.nox',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.eggs']);

/** Translate a minimal glob (`**`, `*`, `?`) into an anchored RegExp over posix paths. */
export function globToRegExp(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(re + '$');
}

/** Every file under `root` as a posix path relative to it, skipping tool and dependency directories. */
export function walk(root) {
  const out = [];
  const visit = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        out.push(relPath);
      }
    }
  };
  visit(root, '');
  return out.sort();
}

/** Files under `root` matching any of `globs`. A glob with no wildcard is an exact relative path. */
export function matchGlobs(root, globs) {
  if (!globs || globs.length === 0) return [];
  const regexps = globs.map(globToRegExp);
  return walk(root).filter((f) => regexps.some((r) => r.test(f)));
}
