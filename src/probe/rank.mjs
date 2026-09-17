import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { walk } from '../util/glob.mjs';

const aliasCache = new Map();

/** Minimal JSONC: strip comments and trailing commas, as tsconfig allows. */
function parseJsonc(text) {
  return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * Alias rules for a project: tsconfig/jsconfig `compilerOptions.paths` (with
 * `baseUrl`, following a relative `extends` a few levels) and package.json
 * `imports`. Bare specifiers that match no rule are ignored, as documented.
 */
export function loadAliases(projectDir) {
  if (aliasCache.has(projectDir)) return aliasCache.get(projectDir);
  const rules = [];
  const toRule = (pattern, targets, base) => {
    const [prefix, suffix = ''] = pattern.split('*');
    rules.push({ prefix, suffix, wildcard: pattern.includes('*'), targets: targets.map((t) => resolve(base, t)) });
  };

  let cfgPath = ['tsconfig.json', 'jsconfig.json'].map((f) => join(projectDir, f)).find(existsSync);
  let baseUrl;
  let paths;
  for (let hop = 0; cfgPath && hop < 5; hop++) {
    let cfg;
    try {
      cfg = parseJsonc(readFileSync(cfgPath, 'utf8'));
    } catch {
      break;
    }
    const co = cfg.compilerOptions ?? {};
    if (baseUrl === undefined && co.baseUrl !== undefined) baseUrl = resolve(dirname(cfgPath), co.baseUrl);
    if (paths === undefined && co.paths !== undefined) paths = { dir: dirname(cfgPath), map: co.paths };
    const ext = typeof cfg.extends === 'string' && cfg.extends.startsWith('.') ? cfg.extends : null;
    cfgPath = ext ? resolve(dirname(cfgPath), ext.endsWith('.json') ? ext : ext + '.json') : null;
  }
  if (paths) {
    const base = baseUrl ?? paths.dir;
    for (const [pattern, targets] of Object.entries(paths.map)) if (Array.isArray(targets)) toRule(pattern, targets, base);
  }

  const pkgPath = join(projectDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const imports = JSON.parse(readFileSync(pkgPath, 'utf8')).imports ?? {};
      for (const [pattern, target] of Object.entries(imports)) {
        const t = typeof target === 'string' ? target : target?.default ?? target?.import ?? target?.node;
        if (typeof t === 'string' && t.startsWith('.')) toRule(pattern, [t], projectDir);
      }
    } catch {}
  }
  aliasCache.set(projectDir, rules);
  return rules;
}

/** Absolute candidate bases an aliased specifier could mean, or [] if it matches no rule. */
function aliasCandidates(specifier, rules) {
  const out = [];
  for (const r of rules) {
    if (r.wildcard) {
      if (specifier.startsWith(r.prefix) && specifier.endsWith(r.suffix) && specifier.length >= r.prefix.length + r.suffix.length) {
        const star = specifier.slice(r.prefix.length, specifier.length - r.suffix.length);
        for (const t of r.targets) out.push(t.replace('*', star));
      }
    } else if (specifier === r.prefix) {
      out.push(...r.targets);
    }
  }
  return out;
}

const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']);
const IMPORT_RE = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

const SEVERITY_WEIGHT = { critical: 8, high: 4, medium: 2, low: 1 };
// A claim written by the same agent that wrote the tests carries less
// independent evidence than one from a human-governed spec.
const SOURCE_WEIGHT = { spec: 1, adr: 1, manual: 0.9, annotation: 0.75, comment: 0.75 };

function expandBase(base) {
  const candidates = [base, ...[...SOURCE_EXT].map((e) => base + e), ...[...SOURCE_EXT].map((e) => join(base, 'index' + e))];
  const stripped = base.replace(/\.(js|mjs|cjs)$/, '');
  candidates.push(stripped + '.ts', stripped + '.mts', stripped + '.tsx');
  return candidates;
}

function resolvesTo(fromFile, specifier, targetAbs, aliases) {
  const bases = specifier.startsWith('.') ? [resolve(dirname(fromFile), specifier)] : aliasCandidates(specifier, aliases);
  return bases.some((b) => expandBase(b).includes(targetAbs));
}

/**
 * Number of non-test source files that import `targetRel`: relative specifiers,
 * tsconfig/jsconfig `paths` aliases and package.json `imports` are resolved;
 * bare package specifiers are not. Direct imports only.
 */
export function blastRadius(projectDir, targetRel) {
  const targetAbs = resolve(projectDir, targetRel);
  const aliases = loadAliases(projectDir);
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
      if (resolvesTo(abs, m[1], targetAbs, aliases)) {
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

