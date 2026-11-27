/**
 * vite/vitest `resolve.alias`, read from the config's tokens — never by
 * running the config (#264). A config may be TypeScript and may import the
 * world; evaluating it would run project code to answer a hashing question.
 *
 * The value of an alias is evaluated over a small, closed grammar of path
 * expressions, which covers what configs ordinarily write:
 *   './src'                                   (project-relative)
 *   fileURLToPath(new URL('./src', import.meta.url))
 *   new URL('./src', import.meta.url).pathname
 *   path.resolve(__dirname, 'src'), resolve(…), join(…), path.join(…), dirname(…)
 *   import.meta.dirname, import.meta.filename, __dirname, __filename, process.cwd()
 *   a top-level `const root = <one of the above>` used by name
 * Anything else is not guessed. An alias whose key is known but whose value
 * is not evaluable is returned with no target: a specifier that matches it
 * resolves to nothing, which makes the closure indeterminate for the files
 * that use it. An alias map that cannot be read at all (a variable, a spread,
 * a computed key, a RegExp `find`) is returned as `opaque`: any bare specifier
 * may be aliased, so every bare specifier is indeterminate. Dropping either
 * silently made its specifiers look like packages, outside the closure — the
 * unsound side.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tokenizeModule } from './imports.mjs';

const id = (t, v) => t?.type === 'id' && (v === undefined || t.value === v);
const pu = (t, v) => t?.type === 'punc' && t.value === v;

function skipBalanced(tokens, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'punc') continue;
    if (pairs[t.value]) stack.push(pairs[t.value]);
    else if (t.value === ')' || t.value === ']' || t.value === '}') {
      if (stack.pop() !== t.value) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** [start, end) ranges of the comma-separated items between `open`+1 and `close`. */
function items(tokens, open, close) {
  const out = [];
  let start = open + 1;
  for (let i = start; i < close; i++) {
    const t = tokens[i];
    if (pu(t, '(') || pu(t, '[') || pu(t, '{')) { const next = skipBalanced(tokens, i); if (next === -1 || next > close) return null; i = next - 1; continue; }
    if (pu(t, ',')) { if (i > start) out.push([start, i]); start = i + 1; }
  }
  if (close > start) out.push([start, close]);
  return out;
}

/** Top-level `const|let|var NAME = …;` bindings: name → [start, end). */
function topLevelBindings(tokens) {
  const bindings = new Map();
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (pu(t, '{') || pu(t, '(') || pu(t, '[')) depth++;
    else if (pu(t, '}') || pu(t, ')') || pu(t, ']')) depth--;
    else if (depth === 0 && ['const', 'let', 'var'].some((w) => id(t, w)) && id(tokens[i + 1]) && pu(tokens[i + 2], '=')) {
      let end = i + 3;
      for (let d = 0; end < tokens.length; end++) {
        const u = tokens[end];
        if (pu(u, '(') || pu(u, '[') || pu(u, '{')) d++;
        else if (pu(u, ')') || pu(u, ']') || pu(u, '}')) d--;
        else if (d === 0 && (pu(u, ';') || pu(u, ',') || (u.lineBreakBefore && end > i + 3 && !pu(tokens[end - 1], '(') && !pu(tokens[end - 1], ',')))) break;
      }
      if (!bindings.has(tokens[i + 1].value)) bindings.set(tokens[i + 1].value, [i + 3, end]);
    }
  }
  return bindings;
}

/**
 * Evaluate tokens[s, e) as a path expression. Returns { kind: 'path', value }
 * (absolute), { kind: 'url', value: URL }, { kind: 'string', value } or null.
 */
function evaluator(tokens, { configFile, projectDir }) {
  const bindings = topLevelBindings(tokens);
  const active = new Set();
  const callee = (s, e) => {
    // `name`, `a.name`, `a.b.name`: the last segment, when the chain is plain identifiers.
    const names = [];
    for (let i = s; i < e; i += 2) {
      if (!id(tokens[i])) return null;
      names.push(tokens[i].value);
      if (i + 1 < e && !pu(tokens[i + 1], '.')) return null;
    }
    return names.at(-1) ?? null;
  };
  const asPath = (v) => {
    if (!v) return null;
    if (v.kind === 'path') return v.value;
    if (v.kind === 'string') return isAbsolute(v.value) ? v.value : null;
    return null;
  };
  const evaluate = (s, e) => {
    if (s >= e) return null;
    // Parenthesized expression.
    if (pu(tokens[s], '(') && skipBalanced(tokens, s) === e) return evaluate(s + 1, e - 1);
    if (e - s === 1) {
      const t = tokens[s];
      if (t.type === 'string') return { kind: 'string', value: t.value };
      if (id(t, '__dirname')) return { kind: 'path', value: dirname(configFile) };
      if (id(t, '__filename')) return { kind: 'path', value: configFile };
      if (id(t) && bindings.has(t.value) && !active.has(t.value)) {
        active.add(t.value);
        const [bs, be] = bindings.get(t.value);
        const value = evaluate(bs, be);
        active.delete(t.value);
        return value;
      }
      return null;
    }
    // import.meta.url / .dirname / .filename
    if (e - s === 5 && id(tokens[s], 'import') && pu(tokens[s + 1], '.') && id(tokens[s + 2], 'meta') && pu(tokens[s + 3], '.')) {
      const prop = tokens[s + 4]?.value;
      if (prop === 'url') return { kind: 'url', value: pathToFileURL(configFile) };
      if (prop === 'dirname') return { kind: 'path', value: dirname(configFile) };
      if (prop === 'filename') return { kind: 'path', value: configFile };
      return null;
    }
    // <expr>.pathname on a URL
    if (pu(tokens[e - 2], '.') && id(tokens[e - 1], 'pathname')) {
      const url = evaluate(s, e - 2);
      return url?.kind === 'url' && url.value.protocol === 'file:' ? { kind: 'path', value: fileURLToPath(url.value) } : null;
    }
    // new URL(a, b)
    if (id(tokens[s], 'new') && id(tokens[s + 1], 'URL') && pu(tokens[s + 2], '(') && skipBalanced(tokens, s + 2) === e) {
      const args = items(tokens, s + 2, e - 1)?.map(([a, b]) => evaluate(a, b));
      if (!args || args.length !== 2 || args[0]?.kind !== 'string' || args[1]?.kind !== 'url') return null;
      try { return { kind: 'url', value: new URL(args[0].value, args[1].value) }; } catch { return null; }
    }
    // name(…) / a.b.name(…)
    const open = tokens.findIndex((t, i) => i >= s && i < e && pu(t, '('));
    if (open > s && skipBalanced(tokens, open) === e) {
      const fn = callee(s, open);
      const args = items(tokens, open, e - 1)?.map(([a, b]) => evaluate(a, b));
      if (!fn || !args || args.some((a) => !a)) return null;
      if (fn === 'cwd' && args.length === 0 && id(tokens[s], 'process')) return { kind: 'path', value: projectDir };
      if (fn === 'fileURLToPath' && args.length === 1) {
        const v = args[0];
        if (v.kind === 'url' && v.value.protocol === 'file:') return { kind: 'path', value: fileURLToPath(v.value) };
        if (v.kind === 'string' && v.value.startsWith('file:')) { try { return { kind: 'path', value: fileURLToPath(v.value) }; } catch { return null; } }
        return null;
      }
      if (fn === 'dirname' && args.length === 1) { const p = asPath(args[0]); return p ? { kind: 'path', value: dirname(p) } : null; }
      if (fn === 'resolve' && args.length) {
        if (args.some((a) => a.kind === 'url')) return null;
        return { kind: 'path', value: resolve(projectDir, ...args.map((a) => a.value)) };
      }
      if (fn === 'join' && args.length) {
        const first = asPath(args[0]);
        if (!first || args.slice(1).some((a) => a.kind !== 'string')) return null;
        return { kind: 'path', value: join(first, ...args.slice(1).map((a) => a.value)) };
      }
      return null;
    }
    return null;
  };
  return evaluate;
}

/** The target an alias value names, absolute; null when it is not a project path this reader can evaluate. */
function targetOf(value, projectDir) {
  if (!value) return null;
  if (value.kind === 'path') return resolve(value.value);
  if (value.kind === 'url') return value.value.protocol === 'file:' ? resolve(fileURLToPath(value.value)) : null;
  const v = value.value;
  if (v.startsWith('./') || v.startsWith('../') || v === '.' || isAbsolute(v)) return resolve(projectDir, v);
  // A bare string is a package substitution, except a project directory
  // named bare (`'src'`), which configs write and earlier readers accepted.
  if (/^[\w.-]+(?:\/[\w.-]+)*\/?$/.test(v) && existsSync(join(projectDir, v)) && statSync(join(projectDir, v)).isDirectory()) return resolve(projectDir, v);
  return undefined;
}

/**
 * Every `alias` the config declares: `{ rules: [{ key, target }], opaque }`.
 * `target` is an absolute path, `null` (the value could not be evaluated) or
 * `undefined` (a package substitution, which resolves outside the project).
 */
export function readConfigAliases(text, { configFile, projectDir }) {
  let tokens;
  try { tokens = tokenizeModule(text); } catch { return { rules: [], opaque: /\balias\b/.test(text) }; }
  const evaluate = evaluator(tokens, { configFile, projectDir });
  const rules = [];
  let opaque = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const isKey = (id(t, 'alias') || (t.type === 'string' && t.value === 'alias')) && !pu(tokens[i - 1], '.');
    if (!isKey) continue;
    if (pu(tokens[i + 1], ',') || pu(tokens[i + 1], '}')) { if (pu(tokens[i - 1], '{') || pu(tokens[i - 1], ',')) opaque = true; continue; } // `{ alias }` shorthand
    if (!pu(tokens[i + 1], ':')) continue;
    const open = i + 2;
    if (pu(tokens[open], '{')) {
      const after = skipBalanced(tokens, open);
      const entries = after === -1 ? null : items(tokens, open, after - 1);
      if (!entries) { opaque = true; continue; }
      for (const [s, e] of entries) {
        const key = tokens[s];
        if (!(id(key) || key.type === 'string') || !pu(tokens[s + 1], ':')) { opaque = true; continue; }
        rules.push({ key: key.value, target: targetOf(evaluate(s + 2, e), projectDir) });
      }
    } else if (pu(tokens[open], '[')) {
      const after = skipBalanced(tokens, open);
      const elements = after === -1 ? null : items(tokens, open, after - 1);
      if (!elements) { opaque = true; continue; }
      for (const [s, e] of elements) {
        if (!pu(tokens[s], '{') || skipBalanced(tokens, s) !== e) { opaque = true; continue; }
        const fields = new Map((items(tokens, s, e - 1) ?? []).filter(([a]) => (id(tokens[a]) || tokens[a].type === 'string') && pu(tokens[a + 1], ':')).map(([a, b]) => [tokens[a].value, [a + 2, b]]));
        const find = fields.get('find');
        const replacement = fields.get('replacement');
        if (!find || find[1] - find[0] !== 1 || tokens[find[0]].type !== 'string') { opaque = true; continue; } // a RegExp find matches what nobody can list
        rules.push({ key: tokens[find[0]].value, target: replacement ? targetOf(evaluate(...replacement), projectDir) : null });
      }
    } else opaque = true;
  }
  return { rules, opaque };
}

/**
 * Jest `moduleNameMapper` (#334), read from the config's tokens like the vite
 * aliases above, never by running the config. Jest resolves a test's imports
 * with this map, so a test that imports its subject through a mapped name is
 * invisible to discovery unless the map is read.
 *
 * Returns `{ rules, opaque }`; a rule is `{ prefix, suffix, wildcard, targets }`
 * (the shape of a tsconfig `paths` rule). A Jest key is a regular expression;
 * only the forms `^lit$`, `^lit`, `^lit(.*)$` and `^lit(.*)lit$` are
 * translated (`(.+)` too, which over-matches the empty capture, the safe
 * side), with `<rootDir>/…$1` (`$1` may repeat) or a package name as the value. Style and asset
 * stubs (`\.(css|png)$`) and the `.js` rewrite for ESM TypeScript are dropped:
 * they name no source module. Jest tries the keys in order, the resolver ranks
 * them by length, so a later rule the resolver would prefer gets no target and
 * its specifiers are indeterminate.
 *
 * Anything else makes the result `opaque` (every bare specifier is then
 * indeterminate): a mapper that is not a literal object (a variable, a call, a
 * spread, a shorthand), a pattern or value that cannot be translated, a
 * config that is not a literal object (a call such as `createJestConfig(…)`,
 * a spread), and every option that changes resolution outside the mapper
 * (`resolver`, `modulePaths`, `moduleDirectories`, `rootDir`, `projects`, a
 * preset other than ts-jest).
 */
const ASSET_EXTENSIONS = new Set(['css', 'less', 'scss', 'sass', 'styl', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'woff', 'woff2', 'ttf', 'eot', 'otf', 'mp3', 'mp4', 'wav', 'webm']);
const ASSET_KEY = /^\^?(?:\(\.[*+]\)|\.[*+])?\\\.(?:\(([a-z0-9|]+)\)|([a-z0-9]+))\$$/;
const OPAQUE_JEST_KEYS = new Set(['resolver', 'modulePaths', 'moduleDirectories', 'rootDir', 'projects']);

function translateJestPattern(src) {
  if (!src.startsWith('^')) return null;
  let i = 1;
  const literal = () => {
    let out = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        if (!/[./\-@:~#%=]/.test(src[i + 1] ?? '')) return null;
        out += src[i + 1];
        i += 2;
      } else if (/[A-Za-z0-9_@/~#:%=-]/.test(c)) { out += c; i++; } else break;
    }
    return out;
  };
  const prefix = literal();
  if (prefix === null) return null;
  let capture = false;
  let suffix = '';
  if (src.startsWith('(.*)', i) || src.startsWith('(.+)', i)) {
    capture = true;
    i += 4;
    suffix = literal();
    if (suffix === null) return null;
  }
  const anchored = src[i] === '$';
  if (anchored) i++;
  if (i !== src.length || (suffix && !anchored)) return null;
  if (capture) return { prefix, suffix, wildcard: true, capture };
  return { prefix, suffix: '', wildcard: !anchored, capture };
}

/** `targets` (absolute, `*` for `$1`), `'package'` (resolves outside the project) or null (not evaluable). */
function jestTargets(values, { capture }, rootDir) {
  const out = [];
  let packages = 0;
  for (const v of values) {
    if (typeof v !== 'string' || v.includes('*') || /\$(?!1(?![0-9]))/.test(v) || (!capture && v.includes('$'))) return null;
    if (v.startsWith('<rootDir>')) {
      const rest = v.slice('<rootDir>'.length);
      if ((rest && !rest.startsWith('/')) || rest.includes('<')) return null;
      out.push(resolve(rootDir, `.${rest}`.replaceAll('$1', '*')));
    } else if (v.startsWith('.') || v.startsWith('/') || v.includes('<')) return null;
    else packages++;
  }
  if (packages) return packages === values.length ? 'package' : null;
  return out;
}

const jestSpecificity = (rule) => rule.prefix.length + rule.suffix.length;
function jestMatches(rule, specifier) {
  return rule.wildcard
    ? specifier.startsWith(rule.prefix) && specifier.endsWith(rule.suffix) && specifier.length >= jestSpecificity(rule)
    : specifier === rule.prefix;
}
/** Could one specifier match both rules? Over-approximated for two wildcards. */
function jestOverlap(a, b) {
  if (!a.wildcard && !b.wildcard) return a.prefix === b.prefix;
  if (!a.wildcard) return jestMatches(b, a.prefix);
  if (!b.wildcard) return jestMatches(a, b.prefix);
  const either = (x, y, test) => test(x, y) || test(y, x);
  return either(a.prefix, b.prefix, (x, y) => x.startsWith(y)) && either(a.suffix, b.suffix, (x, y) => x.endsWith(y));
}
/** The resolver picks an exact rule over a wildcard, else the longer one. Does it pick `first` over `later`? */
function resolverPrefers(first, later) {
  if (first.wildcard !== later.wildcard) return !first.wildcard;
  return jestSpecificity(first) > jestSpecificity(later);
}

/** Does the file export a literal object (`module.exports = {…}`, `export default {…}`, or a binding of one)? */
function exportsLiteralObject(tokens) {
  const startsObject = (i) => pu(tokens[i], '{');
  for (let i = 0; i < tokens.length; i++) {
    let at = -1;
    if (id(tokens[i], 'module') && pu(tokens[i + 1], '.') && id(tokens[i + 2], 'exports') && pu(tokens[i + 3], '=')) at = i + 4;
    else if (id(tokens[i], 'export') && id(tokens[i + 1], 'default')) at = i + 2;
    if (at === -1) continue;
    if (startsObject(at)) return true;
    if (!id(tokens[at]) || ['async', 'function', 'class', 'new'].includes(tokens[at].value)) continue;
    const name = tokens[at].value;
    for (let j = 0; j < tokens.length - 2; j++) {
      if (!(['const', 'let', 'var'].some((w) => id(tokens[j], w)) && id(tokens[j + 1], name))) continue;
      let k = j + 2;
      if (pu(tokens[k], ':')) while (k < tokens.length && !pu(tokens[k], '=')) k++;
      if (pu(tokens[k], '=') && startsObject(k + 1)) return true;
    }
  }
  return false;
}

export function readJestModuleNameMapper(text, { projectDir, json = false }) {
  const none = { rules: [], opaque: false };
  let source = text;
  if (json) {
    try {
      const parsed = JSON.parse(text);
      if (parsed === undefined) return none;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { rules: [], opaque: true };
      source = JSON.stringify(parsed);
    } catch { return { rules: [], opaque: true }; }
  }
  let tokens;
  try { tokens = tokenizeModule(source); } catch { return { rules: [], opaque: true }; }
  if (!json && !exportsLiteralObject(tokens)) return { rules: [], opaque: true };
  let opaque = false;
  const translated = [];
  const keyAt = (i) => (id(tokens[i]) || tokens[i].type === 'string') && !pu(tokens[i - 1], '.');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // A spread (`...x`) may bring in any of it.
    if (pu(t, '.') && pu(tokens[i + 1], '.') && pu(tokens[i + 2], '.')) { opaque = true; continue; }
    if (!keyAt(i)) continue;
    const shorthand = id(t) && (pu(tokens[i + 1], ',') || pu(tokens[i + 1], '}')) && (pu(tokens[i - 1], '{') || pu(tokens[i - 1], ','));
    const named = shorthand || pu(tokens[i + 1], ':');
    if (!named) continue;
    if (OPAQUE_JEST_KEYS.has(t.value) || shorthand && t.value === 'preset') { opaque = true; continue; }
    if (t.value === 'preset') {
      const v = tokens[i + 2];
      if (!(v?.type === 'string' && (v.value === 'ts-jest' || v.value.startsWith('ts-jest/')))) opaque = true;
      continue;
    }
    if (t.value !== 'moduleNameMapper') continue;
    if (shorthand || !pu(tokens[i + 2], '{')) { opaque = true; continue; }
    const after = skipBalanced(tokens, i + 2);
    const entries = after === -1 ? null : items(tokens, i + 2, after - 1);
    if (!entries) { opaque = true; continue; }
    for (const [s, e] of entries) {
      const key = tokens[s];
      if (key.type !== 'string' || !pu(tokens[s + 1], ':')) { opaque = true; continue; }
      let values = null; // string values, or null when any is not a string literal
      if (e - s === 3 && tokens[s + 2].type === 'string') values = [tokens[s + 2].value];
      else if (pu(tokens[s + 2], '[') && skipBalanced(tokens, s + 2) === e) {
        const elements = items(tokens, s + 2, e - 1);
        if (elements?.length && elements.every(([a, b]) => b - a === 1 && tokens[a].type === 'string')) values = elements.map(([a]) => tokens[a].value);
      }
      const asset = ASSET_KEY.exec(key.value);
      if (asset && (asset[1] ?? asset[2]).split('|').every((ext) => ASSET_EXTENSIONS.has(ext))) continue; // a stub for a file that is no source module
      if (key.value === '^(\\.{1,2}/.*)\\.js$' && values?.length === 1 && values[0] === '$1') continue; // the ESM `.js` rewrite; the resolver already tries the TypeScript source
      const pattern = translateJestPattern(key.value);
      if (!pattern) { opaque = true; continue; }
      const targets = values ? jestTargets(values, pattern, projectDir) : null;
      if (targets === 'package') continue; // outside the project, like any package
      translated.push({ prefix: pattern.prefix, suffix: pattern.suffix, wildcard: pattern.wildcard, targets: targets ?? [] });
    }
  }
  // Jest tries the keys in order; where the resolver would not pick the earlier
  // rule for a specifier both match, that specifier must not resolve.
  const rules = translated.map((rule, j) => (
    translated.slice(0, j).some((earlier) => jestOverlap(earlier, rule) && !resolverPrefers(earlier, rule)) ? { ...rule, targets: [] } : rule
  ));
  return { rules, opaque };
}
