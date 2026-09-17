import { readFileSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { walk } from '../util/glob.mjs';

const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']);
const IMPORT_RE = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

const SEVERITY_WEIGHT = { critical: 8, high: 4, medium: 2, low: 1 };
// A claim written by the same agent that wrote the tests carries less
// independent evidence than one from a human-governed spec.
const SOURCE_WEIGHT = { spec: 1, adr: 1, manual: 0.9, annotation: 0.75, comment: 0.75 };

function resolvesTo(fromFile, specifier, targetAbs) {
  if (!specifier.startsWith('.')) return false;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, ...[...SOURCE_EXT].map((e) => base + e), ...[...SOURCE_EXT].map((e) => join(base, 'index' + e))];
  const stripped = base.replace(/\.(js|mjs|cjs)$/, '');
  candidates.push(stripped + '.ts', stripped + '.mts', stripped + '.tsx');
  return candidates.includes(targetAbs);
}

/** Number of non-test source files that import `targetRel` (direct imports only, documented as such). */
export function blastRadius(projectDir, targetRel) {
  const targetAbs = resolve(projectDir, targetRel);
  let count = 0;
  for (const rel of walk(projectDir)) {
    if (!SOURCE_EXT.has(extname(rel)) || TEST_RE.test(rel) || rel === targetRel) continue;
    const abs = join(projectDir, rel);
    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(IMPORT_RE)) {
      if (resolvesTo(abs, m[1], targetAbs)) {
        count++;
        break;
      }
    }
  }
  return count;
}

/** Additive ordering only. Never touches the verdict. */
export function rank({ severity, sourceKind, blast }) {
  const score = SEVERITY_WEIGHT[severity] * (SOURCE_WEIGHT[sourceKind] ?? 0.9) * (1 + Math.log2(1 + blast));
  return { score: Number(score.toFixed(3)), blastRadius: blast, tier: severity };
}

