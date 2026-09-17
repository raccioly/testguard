import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.kt', '.md']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(tests?|__tests__)\//;
// An annotation id must contain a hyphen (REDACT-001, TG-KILL-NEEDS-N). Prose
// such as "@claim annotations" is not an annotation.
const RE = /@claim\s+([A-Za-z0-9]+(?:[._]?[A-Za-z0-9]+)*-[A-Za-z0-9._-]*[A-Za-z0-9])\b/g;

/**
 * Source files worth scanning: skips hidden directories (tooling), dependency
 * and build output, test files (a claim asserted by a test is the authorship
 * trap this tool exists for), and nested projects that carry their own
 * claims file.
 */
function sourceFiles(root) {
  const out = [];
  const visit = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        if (existsSync(join(dir, e.name, 'testguard.claims.json'))) continue;
        visit(join(dir, e.name), relPath);
      } else if (e.isFile() && SCAN_EXT.has(extname(e.name)) && !TEST_FILE.test(relPath)) {
        out.push(relPath);
      }
    }
  };
  visit(root, '');
  return out.sort();
}

/** Every `@claim <ID>` annotation in source, with where it was found. */
export function scanAnnotations(projectDir) {
  const found = [];
  for (const rel of sourceFiles(projectDir)) {
    readFileSync(join(projectDir, rel), 'utf8').split('\n').forEach((text, i) => {
      for (const m of text.matchAll(RE)) found.push({ id: m[1], file: rel, line: i + 1 });
    });
  }
  return found;
}

/**
 * Drift between what the code annotates and what the claims file declares.
 * `undeclared`: annotated in code, absent from the file — a claim with no
 * fault model. `stale`: declared as annotation-sourced, but no code carries it.
 */
export function reconcile(claims, annotations) {
  const declared = new Map(claims.claims.map((c) => [c.id, c]));
  const annotated = new Set(annotations.map((a) => a.id));
  return {
    undeclared: annotations.filter((a) => !declared.has(a.id)),
    stale: claims.claims.filter((c) => c.source.kind === 'annotation' && !annotated.has(c.id)),
    annotated: [...declared.keys()].filter((id) => annotated.has(id)),
  };
}
