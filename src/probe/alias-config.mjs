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
