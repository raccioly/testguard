import { readFileSync, readdirSync, existsSync, opendirSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { join, extname } from 'node:path';

const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.kt', '.md']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(tests?|__tests__)\//;
// An annotation id must contain a hyphen (REDACT-001, TG-KILL-NEEDS-N). Prose
// such as "@claim annotations" is not an annotation.
const RE = /@claim\s+([A-Za-z0-9]+(?:[._][A-Za-z0-9]+)*-[A-Za-z0-9._-]*[A-Za-z0-9])\b/g;

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

/** Lexical links aid discovery, never verification or provenance authentication. */
export function annotationAdvisory(claims, annotations, { customClaims = false } = {}) {
  const linked = new Set(annotations.map((a) => a.id));
  const missingIds = [...new Set(claims.claims.map((c) => c.id))].filter((id) => !linked.has(id)).sort();
  return {
    missingIds,
    notes: missingIds.length ? [
      `ANNOTATION ADVISORY: ${missingIds.length} declared claim ID${missingIds.length === 1 ? '' : 's'} lack a scanned source link. Discoverability and annotation reconciliation are reduced; exact fault anchors remain checked.`,
      ...missingIds.map((id) => `Missing source annotation: ${id}`),
      'Optional read-only preview in the selected project: testguard claims --annotate. Placement is not verification or authenticated intent; review before explicitly applying.',
      ...(customClaims ? ['Preserve the original --claims argument when running that preview; the default claims file is not this selection.'] : []),
    ] : [],
  };
}

/** Advice cannot turn unrelated file failures or excessive reads into status failure. */
export function projectAnnotationAdvisory(projectDir, claims, options) {
  const annotations = [];
  let entries = 0; let files = 0; let bytes = 0;
  const visit = (dir, rel, depth) => {
    if (depth > 64) throw new Error('scan incomplete');
    const directory = opendirSync(dir);
    try {
      let e;
      while ((e = directory.readSync())) {
        if (++entries > 10000) throw new Error('scan incomplete');
        const file = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || existsSync(join(dir, e.name, 'testguard.claims.json'))) continue;
          visit(join(dir, e.name), file, depth + 1);
        } else if (e.isFile() && SCAN_EXT.has(extname(e.name)) && !TEST_FILE.test(file)) {
          if (++files > 1000) throw new Error('scan incomplete');
          const fd = openSync(join(dir, e.name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const stat = fstatSync(fd);
            const limit = Math.min(256 * 1024, 2 * 1024 * 1024 - bytes);
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('scan incomplete');
            const buffer = Buffer.alloc(limit + 1);
            let read = 0; let n;
            while ((n = readSync(fd, buffer, read, buffer.length - read, null))) {
              read += n;
              if (read > limit) throw new Error('scan incomplete');
            }
            bytes += read;
            const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, read));
            text.split('\n').forEach((line, i) => {
              for (const m of line.matchAll(RE)) annotations.push({ id: m[1], file, line: i + 1 });
            });
          } finally { closeSync(fd); }
        }
      }
    } finally { directory.closeSync(); }
  };
  try { visit(projectDir, '', 0); return annotationAdvisory(claims, annotations, options); }
  catch {
    return { missingIds: [], notes: ['ANNOTATION ADVISORY unavailable: source scan was incomplete or exceeded its resource limits. No missing-ID conclusion was made; verification state and next action are unchanged.'] };
  }
}
