import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { walk } from '../util/glob.mjs';
import { pyBlastRadius } from './pyimports.mjs';

const aliasCache = new Map();

/** Minimal JSONC: strip comments and trailing commas, as tsconfig allows. */
function parseJsonc(text) {
  return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * Alias rules for a project: tsconfig/jsconfig `compilerOptions.paths` (with
 * `baseUrl`, following a relative `extends` a few levels, and every
 * `references[].path` — Vite projects keep `paths` in `tsconfig.app.json`),
 * vite/vitest `resolve.alias` read as text, and package.json `imports`. Bare
 * specifiers that match no rule are ignored, as documented.
 */
export function loadAliases(projectDir) {
  if (aliasCache.has(projectDir)) return aliasCache.get(projectDir);
  const rules = [];
  const toRule = (pattern, targets, base) => {
    const [prefix, suffix = ''] = pattern.split('*');
    rules.push({ prefix, suffix, wildcard: pattern.includes('*'), targets: targets.map((t) => resolve(base, t)) });
  };

  // Every tsconfig in the chain: the root, what it extends, what it references.
  const seen = new Set();
  const queue = ['tsconfig.json', 'jsconfig.json'].map((f) => join(projectDir, f)).filter(existsSync).slice(0, 1);
  while (queue.length && seen.size < 12) {
    const cfgPath = queue.shift();
    if (seen.has(cfgPath) || !existsSync(cfgPath)) continue;
    seen.add(cfgPath);
    let cfg;
    try {
      cfg = parseJsonc(readFileSync(cfgPath, 'utf8'));
    } catch {
      continue;
    }
    const co = cfg.compilerOptions ?? {};
    if (co.paths) {
      const base = co.baseUrl !== undefined ? resolve(dirname(cfgPath), co.baseUrl) : dirname(cfgPath);
      for (const [pattern, targets] of Object.entries(co.paths)) if (Array.isArray(targets)) toRule(pattern, targets, base);
    }
    const ext = typeof cfg.extends === 'string' && cfg.extends.startsWith('.') ? cfg.extends : null;
    if (ext) queue.push(resolve(dirname(cfgPath), ext.endsWith('.json') ? ext : ext + '.json'));
    for (const ref of Array.isArray(cfg.references) ? cfg.references : []) {
      if (typeof ref?.path !== 'string') continue;
      const p = resolve(dirname(cfgPath), ref.path);
      queue.push(p.endsWith('.json') ? p : join(p, 'tsconfig.json'));
    }
  }

  // vite / vitest config: `resolve.alias` as `{ '@': path.resolve(__dirname, './src') }`,
  // `{ '@': fileURLToPath(new URL('./src', import.meta.url)) }`, `{ '@': './src' }`
  // or `[{ find: '@', replacement: … }]`. Read as text: the config may be TypeScript.
  for (const f of ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs', 'vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']) {
    const path = join(projectDir, f);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    const start = /\balias\s*:\s*([\[{])/.exec(text);
    if (!start) continue;
    // Take the balanced bracket block that follows `alias:`.
    const open = start.index + start[0].length - 1;
    const pairs = { '{': '}', '[': ']' };
    let depth = 0;
    let end = -1;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{' || text[i] === '[' || text[i] === '(') depth++;
      else if (text[i] === '}' || text[i] === ']' || text[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) continue;
    const block = text.slice(open, end + 1);
    const PATHLIKE = /(['"])(\.{1,2}\/[^'"]*|src(?:\/[^'"]*)?)\1/;
    let entries;
    if (start[1] === '[') {
      entries = [...block.matchAll(/find\s*:\s*(['"])([^'"]+)\1([\s\S]*?)(?=find\s*:|\]$)/g)].map((m) => [m[2], m[3]]);
    } else {
      // key: <value up to the next top-level key>; the value may contain calls with their own commas
      const keys = [...block.matchAll(/(['"]?)([@#~$\w./-]+)\1\s*:(?!\/)/g)];
      entries = keys.map((k, i) => [k[2], block.slice(k.index + k[0].length, keys[i + 1]?.index ?? block.length)]);
    }
    for (const [key, value] of entries) {
      const target = PATHLIKE.exec(value)?.[2];
      if (!key || !target) continue;
      const abs = resolve(projectDir, target);
      rules.push({ prefix: key, suffix: '', wildcard: false, targets: [abs] });
      rules.push({ prefix: key.endsWith('/') ? key : key + '/', suffix: '', wildcard: true, targets: [join(abs, '*')] });
    }
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

/** Does `specifier`, as written in `absFile`, resolve to `targetRel` (relative or alias-resolved)? */
export function specifierResolvesTo(projectDir, absFile, specifier, targetRel) {
  return resolvesTo(absFile, specifier, resolve(projectDir, targetRel), loadAliases(projectDir));
}

/** Clear the alias cache (tests create and delete projects at the same paths). */
export const resetAliasCache = () => aliasCache.clear();

/** Does the file at `absFile` import `targetRel` (relative or alias-resolved)? */
export function fileImports(projectDir, absFile, targetRel) {
  const targetAbs = resolve(projectDir, targetRel);
  const aliases = loadAliases(projectDir);
  let src;
  try {
    src = readFileSync(absFile, 'utf8');
  } catch {
    return false;
  }
  for (const m of src.matchAll(IMPORT_RE)) if (resolvesTo(absFile, m[1], targetAbs, aliases)) return true;
  return false;
}

/**
 * Number of non-test source files that import `targetRel`: relative specifiers,
 * tsconfig/jsconfig `paths` aliases and package.json `imports` are resolved;
 * bare package specifiers are not. Direct imports only.
 */
export function blastRadius(projectDir, targetRel) {
  if (targetRel.endsWith('.py')) return pyBlastRadius(projectDir, targetRel);
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

// A kill whose defender was written in the same change as the code carries
// less independent evidence. Ranking may read the signal; verdicts never do.
const INDEPENDENCE_WEIGHT = { 'separate-change': 1, unknown: 0.95, 'co-authored': 0.85 };

/** Additive ordering only. Never touches the verdict. */
export function rank({ severity, sourceKind, blast, independence }) {
  const score = SEVERITY_WEIGHT[severity] * (SOURCE_WEIGHT[sourceKind] ?? 0.9) * (1 + Math.log2(1 + blast)) * (INDEPENDENCE_WEIGHT[independence] ?? 1);
  return { score: Number(score.toFixed(3)), blastRadius: blast, tier: severity };
}

