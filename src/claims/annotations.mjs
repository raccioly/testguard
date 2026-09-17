import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { walk } from '../util/glob.mjs';

const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.kt', '.md']);
const RE = /@claim\s+([A-Za-z0-9][A-Za-z0-9._-]*)/g;

/** Every `@claim <ID>` token in source, with where it was found. */
export function scanAnnotations(projectDir) {
  const found = [];
  for (const rel of walk(projectDir)) {
    if (!SCAN_EXT.has(extname(rel))) continue;
    const lines = readFileSync(join(projectDir, rel), 'utf8').split('\n');
    lines.forEach((text, i) => {
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
