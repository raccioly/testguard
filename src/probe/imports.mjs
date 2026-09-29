import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const IMPORT_LIMITS = Object.freeze({
  maxFileBytes: 1_048_576,
  maxDepth: 32,
  maxModules: 256,
  maxEdges: 1_024,
  maxTotalBytes: 16_777_216,
  maxWitnessPaths: 32,
});

const SOURCE_EXTENSIONS = Object.freeze(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const SCRIPT_FALLBACKS = Object.freeze({ '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] });

const identifier = (token, value) => token?.type === 'id' && (value === undefined || token.value === value);
const punct = (token, value) => token?.type === 'punc' && token.value === value;

function decodeString(source, start) {
  const quote = source[start];
  let value = '';
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === quote) return { value, end: i + 1 };
    if (ch === '\n' || ch === '\r') throw new SyntaxError('unterminated string literal');
    if (ch !== '\\') {
      value += ch;
      continue;
    }
    const next = source[++i];
    if (next === undefined) throw new SyntaxError('unterminated string escape');
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0', '\\': '\\', "'": "'", '"': '"' };
    if (next in simple) {
      value += simple[next];
      continue;
    }
    if (next === 'x') {
      const hex = source.slice(i + 1, i + 3);
      if (!/^[0-9a-f]{2}$/i.test(hex)) throw new SyntaxError('invalid hexadecimal string escape');
      value += String.fromCodePoint(Number.parseInt(hex, 16));
      i += 2;
      continue;
    }
    if (next === 'u') {
      if (source[i + 1] === '{') {
        const close = source.indexOf('}', i + 2);
        const hex = close === -1 ? '' : source.slice(i + 2, close);
        if (!/^[0-9a-f]{1,6}$/i.test(hex)) throw new SyntaxError('invalid unicode string escape');
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        i = close;
      } else {
        const hex = source.slice(i + 1, i + 5);
        if (!/^[0-9a-f]{4}$/i.test(hex)) throw new SyntaxError('invalid unicode string escape');
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 4;
      }
      continue;
    }
    if (next === '\n') continue;
    if (next === '\r' && source[i + 1] === '\n') {
      i++;
      continue;
    }
    value += next;
  }
  throw new SyntaxError('unterminated string literal');
}

/** A deliberately small lexer: enough grammar to read module boundaries, never executable code. */
export function tokenizeModule(source) {
  const tokens = [];
  let lineBreakBefore = false;
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      if (ch === '\n' || ch === '\r') lineBreakBefore = true;
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i + 2);
      if (i === -1) break;
      lineBreakBefore = true;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) throw new SyntaxError('unterminated block comment');
      if (source.slice(i, end + 2).includes('\n')) lineBreakBefore = true;
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const string = decodeString(source, i);
      tokens.push({ type: 'string', value: string.value, index: i, lineBreakBefore });
      lineBreakBefore = false;
      i = string.end;
      continue;
    }
    if (ch === '`') {
      const start = i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\') i += 2;
        else if (source[i] === '`') { i++; closed = true; break; }
        else i++;
      }
      if (!closed) throw new SyntaxError('unterminated template literal');
      tokens.push({ type: 'template', value: null, index: start, lineBreakBefore });
      lineBreakBefore = false;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (end < source.length && /[\w$]/.test(source[end])) end++;
      tokens.push({ type: 'id', value: source.slice(i, end), index: i, lineBreakBefore });
      lineBreakBefore = false;
      i = end;
      continue;
    }
    tokens.push({ type: 'punc', value: ch, index: i, lineBreakBefore });
    lineBreakBefore = false;
    i++;
  }
  return tokens;
}

function statementEnd(tokens, start) {
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (i > start && braces === 0 && parens === 0 && brackets === 0 && t.lineBreakBefore && (identifier(t, 'import') || identifier(t, 'export'))) return i;
    if (punct(t, '{')) braces++;
    else if (punct(t, '}')) { if (braces === 0) return i; braces--; }
    else if (punct(t, '(')) parens++;
    else if (punct(t, ')')) parens--;
    else if (punct(t, '[')) brackets++;
    else if (punct(t, ']')) brackets--;
    else if (punct(t, ';') && braces === 0 && parens === 0 && brackets === 0) return i + 1;
  }
  return tokens.length;
}

function namedEntries(tokens, open, close) {
  const entries = [];
  let i = open + 1;
  while (i < close) {
    if (punct(tokens[i], ',')) { i++; continue; }
    let typeOnly = false;
    if (identifier(tokens[i], 'type')) { typeOnly = true; i++; }
    if (!identifier(tokens[i])) return null;
    const imported = tokens[i++].value;
    let exported = imported;
    if (identifier(tokens[i], 'as')) {
      i++;
      if (!identifier(tokens[i])) return null;
      exported = tokens[i++].value;
    }
    entries.push({ imported, exported, typeOnly });
    if (i < close && !punct(tokens[i], ',')) return null;
  }
  return entries;
}

function addExplicit(module, name, origin) {
  const existing = module.explicit.get(name) ?? [];
  existing.push(origin);
  module.explicit.set(name, existing);
}

function parseStaticImport(tokens, start, module) {
  const end = statementEnd(tokens, start);
  if (punct(tokens[start + 1], '(')) return start + 1; // dynamic import: parsed below
  if (tokens[start + 1]?.type === 'string') {
    module.requests.push({ specifier: tokens[start + 1].value, mode: 'runtime' });
    module.runtime.push(tokens[start + 1].value);
    return end;
  }
  if (identifier(tokens[start + 1], 'type')) return end;
  const from = tokens.findIndex((t, i) => i > start && i < end && identifier(t, 'from'));
  if (from === -1 || tokens[from + 1]?.type !== 'string') {
    module.uncertain.push('unsupported-syntax');
    return end;
  }
  const specifier = tokens[from + 1].value;
  module.runtime.push(specifier);
  let i = start + 1;
  if (identifier(tokens[i]) && !identifier(tokens[i], 'type')) {
    module.localImports.set(tokens[i].value, { specifier, imported: 'default' });
    module.requests.push({ specifier, symbol: 'default', local: tokens[i].value, mode: 'symbol' });
    module.bindingTokenIndexes.add(i);
    i++;
    if (punct(tokens[i], ',')) i++;
  }
  if (punct(tokens[i], '*') && identifier(tokens[i + 1], 'as') && identifier(tokens[i + 2])) {
    const local = tokens[i + 2].value;
    module.namespaceImports.push({ specifier, local, tokenIndex: i + 2 });
    module.bindingTokenIndexes.add(i + 2);
  } else if (punct(tokens[i], '{')) {
    const close = tokens.findIndex((t, n) => n > i && n < from && punct(t, '}'));
    const entries = close === -1 ? null : namedEntries(tokens, i, close);
    if (!entries) module.uncertain.push('unsupported-syntax');
    else for (const entry of entries.filter((e) => !e.typeOnly)) {
      module.localImports.set(entry.exported, { specifier, imported: entry.imported });
      module.requests.push({ specifier, symbol: entry.imported, local: entry.exported, mode: 'symbol' });
      const localIndex = tokens.findIndex((t, n) => n > i && n < close && identifier(t, entry.exported));
      if (localIndex !== -1) module.bindingTokenIndexes.add(localIndex);
    }
  }
  return end;
}

function parseExport(tokens, start, module) {
  const end = statementEnd(tokens, start);
  let i = start + 1;
  if (identifier(tokens[i], 'type')) return end;
  if (punct(tokens[i], '*')) {
    i++;
    let exported = null;
    if (identifier(tokens[i], 'as') && identifier(tokens[i + 1])) { exported = tokens[i + 1].value; i += 2; }
    if (!identifier(tokens[i], 'from') || tokens[i + 1]?.type !== 'string') module.uncertain.push('unsupported-syntax');
    else if (exported) addExplicit(module, exported, { kind: 'namespace', specifier: tokens[i + 1].value });
    else module.stars.push(tokens[i + 1].value);
    if (tokens[i + 1]?.type === 'string') module.runtime.push(tokens[i + 1].value);
    return end;
  }
  if (punct(tokens[i], '{')) {
    const close = tokens.findIndex((t, n) => n > i && n < end && punct(t, '}'));
    const entries = close === -1 ? null : namedEntries(tokens, i, close);
    if (!entries) { module.uncertain.push('unsupported-syntax'); return end; }
    const from = close + 1 < end && identifier(tokens[close + 1], 'from') && tokens[close + 2]?.type === 'string' ? tokens[close + 2].value : null;
    if (from) module.runtime.push(from);
    for (const entry of entries.filter((e) => !e.typeOnly)) {
      addExplicit(module, entry.exported, from
        ? { kind: 'remote', specifier: from, imported: entry.imported }
        : { kind: 'local', local: entry.imported });
    }
    return end;
  }
  if (identifier(tokens[i], 'default')) {
    addExplicit(module, 'default', { kind: 'terminal', symbol: 'default' });
    return end;
  }
  if (identifier(tokens[i], 'async') && identifier(tokens[i + 1], 'function') && identifier(tokens[i + 2])) {
    addExplicit(module, tokens[i + 2].value, { kind: 'terminal', symbol: tokens[i + 2].value });
    return end;
  }
  if (['const', 'let', 'var', 'function', 'class'].some((word) => identifier(tokens[i], word)) && identifier(tokens[i + 1])) {
    addExplicit(module, tokens[i + 1].value, { kind: 'terminal', symbol: tokens[i + 1].value });
    return end;
  }
  module.uncertain.push('unsupported-syntax');
  return end;
}

function requireCall(tokens, i) {
  if (!identifier(tokens[i], 'require') || !punct(tokens[i + 1], '(') || tokens[i + 2]?.type !== 'string' || !punct(tokens[i + 3], ')')) return null;
  return { specifier: tokens[i + 2].value, end: i + 4 };
}

function dynamicImportCall(tokens, i) {
  if (!identifier(tokens[i], 'import') || !punct(tokens[i + 1], '(') || tokens[i + 2]?.type !== 'string' || !punct(tokens[i + 3], ')')) return null;
  return { specifier: tokens[i + 2].value, end: i + 4 };
}

function commonJsObjectEntries(tokens, open) {
  const entries = [];
  let i = open + 1;
  while (i < tokens.length && !punct(tokens[i], '}')) {
    if (punct(tokens[i], ',')) { i++; continue; }
    const key = identifier(tokens[i]) || tokens[i]?.type === 'string' ? tokens[i].value : null;
    if (!key) return null;
    i++;
    let local = key;
    if (punct(tokens[i], ':')) {
      i++;
      if (!identifier(tokens[i])) return null;
      local = tokens[i].value;
      i++;
    }
    entries.push({ exported: key, local });
    if (!punct(tokens[i], ',') && !punct(tokens[i], '}')) return null;
  }
  return punct(tokens[i], '}') ? entries : null;
}

function isCommonJsExportsReference(tokens, i) {
  if (identifier(tokens[i], 'exports')) return i + 1;
  if (identifier(tokens[i], 'module') && punct(tokens[i + 1], '.') && identifier(tokens[i + 2], 'exports')) return i + 3;
  return -1;
}

/**
 * Generated CommonJS uses several export mutations that the deliberately
 * small resolver does not model. Seeing one in a reached module must poison a
 * negative result: otherwise a transpiler helper can hide a real re-export
 * and turn uncertainty into `not-matched`.
 */
function hasUnsupportedCommonJsExportMutation(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    // Object.defineProperty(exports, "name", descriptor) and its
    // module.exports variant can encode getters/re-exports.
    if (identifier(tokens[i], 'Object') && punct(tokens[i + 1], '.')
      && ['defineProperty', 'defineProperties'].some((name) => identifier(tokens[i + 2], name))
      && punct(tokens[i + 3], '(') && isCommonJsExportsReference(tokens, i + 4) !== -1) return true;

    // TypeScript/esbuild-style star forwarding. The helper's implementation
    // is irrelevant; the call mutates the public export surface.
    if (identifier(tokens[i]) && /(?:^|_)exportStar$/.test(tokens[i].value)
      && punct(tokens[i + 1], '(')) {
      let depth = 0;
      for (let n = i + 1; n < tokens.length; n++) {
        if (punct(tokens[n], '(')) depth++;
        else if (punct(tokens[n], ')')) {
          depth--;
          if (depth === 0) break;
        } else if (depth > 0 && isCommonJsExportsReference(tokens, n) !== -1) return true;
      }
    }

    // Computed export writes may be statically spelled today and become
    // dynamic after another compiler transform. Do not partially interpret
    // this family until the grammar is modelled as a whole.
    const afterExports = isCommonJsExportsReference(tokens, i);
    if (afterExports !== -1 && punct(tokens[afterExports], '[')) {
      let depth = 1;
      let n = afterExports + 1;
      while (n < tokens.length && depth > 0) {
        if (punct(tokens[n], '[')) depth++;
        else if (punct(tokens[n], ']')) depth--;
        n++;
      }
      if (depth === 0 && punct(tokens[n], '=')) return true;
    }
  }
  return false;
}

function parseCommonJsExports(tokens, module) {
  if (hasUnsupportedCommonJsExportMutation(tokens)) module.uncertain.push('unsupported-syntax');
  for (let i = 0; i < tokens.length; i++) {
    let exported;
    let eq;
    if (identifier(tokens[i], 'module') && punct(tokens[i + 1], '.') && identifier(tokens[i + 2], 'exports')) {
      if (punct(tokens[i + 3], '.')) { exported = tokens[i + 4]?.value; eq = i + 5; }
      else { exported = '*'; eq = i + 3; }
    } else if (identifier(tokens[i], 'exports') && punct(tokens[i + 1], '.')) {
      exported = tokens[i + 2]?.value;
      eq = i + 3;
    }
    if (!exported || !punct(tokens[eq], '=')) continue;
    const call = requireCall(tokens, eq + 1);
    if (call) {
      const imported = punct(tokens[call.end], '.') && identifier(tokens[call.end + 1]) ? tokens[call.end + 1].value : exported;
      module.runtime.push(call.specifier);
      if (exported === '*') module.cjsStars.push(call.specifier);
      else addExplicit(module, exported, { kind: 'remote', specifier: call.specifier, imported });
    } else if (exported === '*' && punct(tokens[eq + 1], '{')) {
      const entries = commonJsObjectEntries(tokens, eq + 1);
      if (!entries) module.uncertain.push('unsupported-syntax');
      else for (const entry of entries) addExplicit(module, entry.exported, { kind: 'local', local: entry.local });
    } else if (exported !== '*' && identifier(tokens[eq + 1])) {
      addExplicit(module, exported, { kind: 'local', local: tokens[eq + 1].value });
    } else if (exported !== '*') {
      addExplicit(module, exported, { kind: 'terminal', symbol: exported });
    } else {
      module.uncertain.push('unsupported-syntax');
    }
  }
}

function destructuredNames(tokens, open, close) {
  const out = [];
  let i = open + 1;
  while (i < close) {
    if (punct(tokens[i], ',')) { i++; continue; }
    if (!identifier(tokens[i])) return null;
    const imported = tokens[i++].value;
    let local = imported;
    if (punct(tokens[i], ':')) {
      i++;
      if (!identifier(tokens[i])) return null;
      local = tokens[i++].value;
    }
    out.push({ imported, local });
    if (i < close && !punct(tokens[i], ',')) return null;
  }
  return out;
}

function parseRuntimeImports(tokens, module) {
  const consumed = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (!['const', 'let', 'var'].some((word) => identifier(tokens[i], word))) continue;
    if (punct(tokens[i + 1], '{')) {
      const close = tokens.findIndex((t, n) => n > i + 1 && punct(t, '}'));
      if (close === -1 || !punct(tokens[close + 1], '=')) continue;
      let callStart = close + 2;
      if (identifier(tokens[callStart], 'await')) callStart++;
      const call = requireCall(tokens, callStart) ?? dynamicImportCall(tokens, callStart);
      if (!call) continue;
      const names = destructuredNames(tokens, i + 1, close);
      if (!names) { module.uncertain.push('unsupported-syntax'); continue; }
      module.runtime.push(call.specifier);
      for (const name of names) {
        module.requests.push({ specifier: call.specifier, symbol: name.imported, local: name.local, mode: 'symbol' });
        module.localImports.set(name.local, { specifier: call.specifier, imported: name.imported });
        const localIndex = tokens.findIndex((t, n) => n > i + 1 && n < close && identifier(t, name.local));
        if (localIndex !== -1) module.bindingTokenIndexes.add(localIndex);
      }
      for (let n = callStart; n < call.end; n++) consumed.add(n);
    } else if (identifier(tokens[i + 1]) && punct(tokens[i + 2], '=')) {
      let callStart = i + 3;
      if (identifier(tokens[callStart], 'await')) callStart++;
      const call = requireCall(tokens, callStart) ?? dynamicImportCall(tokens, callStart);
      if (!call) continue;
      module.runtime.push(call.specifier);
      const local = tokens[i + 1].value;
      if (punct(tokens[call.end], '.') && identifier(tokens[call.end + 1])) {
        const imported = tokens[call.end + 1].value;
        module.requests.push({ specifier: call.specifier, symbol: imported, local, mode: 'symbol' });
        module.localImports.set(local, { specifier: call.specifier, imported });
        consumed.add(call.end);
        consumed.add(call.end + 1);
      } else {
        module.namespaceImports.push({ specifier: call.specifier, local, tokenIndex: i + 1 });
      }
      module.bindingTokenIndexes.add(i + 1);
      for (let n = callStart; n < call.end; n++) consumed.add(n);
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
    const call = requireCall(tokens, i) ?? dynamicImportCall(tokens, i);
    if (!call) continue;
    module.runtime.push(call.specifier);
    if (punct(tokens[call.end], '.') && identifier(tokens[call.end + 1])) module.requests.push({ specifier: call.specifier, symbol: tokens[call.end + 1].value, mode: 'symbol' });
    else module.requests.push({ specifier: call.specifier, mode: 'runtime' });
    i = call.end - 1;
  }
}

function namespaceRequests(tokens, module) {
  for (const ns of module.namespaceImports) {
    const names = new Set();
    let opaque = false;
    for (let i = 0; i < tokens.length; i++) {
      if (!identifier(tokens[i], ns.local) || i === ns.tokenIndex || module.bindingTokenIndexes.has(i)) continue;
      if (punct(tokens[i + 1], '.') && identifier(tokens[i + 2])) { names.add(tokens[i + 2].value); continue; }
      if (punct(tokens[i + 1], '[') && tokens[i + 2]?.type === 'string' && punct(tokens[i + 3], ']')) { names.add(tokens[i + 2].value); continue; }
      if (punct(tokens[i - 1], '=') && punct(tokens[i - 2], '}')) {
        let open = i - 2;
        while (open >= 0 && !punct(tokens[open], '{')) open--;
        const entries = open >= 0 ? destructuredNames(tokens, open, i - 2) : null;
        if (entries) { for (const entry of entries) names.add(entry.imported); continue; }
      }
      opaque = true;
    }
    if (opaque || names.size === 0) module.requests.push({ specifier: ns.specifier, mode: 'unknown-namespace', local: ns.local });
    else for (const symbol of names) module.requests.push({ specifier: ns.specifier, symbol, local: ns.local, mode: 'symbol' });
  }
}

/** Parse only the static module forms the resolver promises; unsupported reached forms stay explicit. */
export function parseModuleSource(source) {
  const tokens = tokenizeModule(source);
  const module = {
    tokens,
    requests: [], runtime: [], explicit: new Map(), stars: [], cjsStars: [],
    localImports: new Map(), namespaceImports: [], bindingTokenIndexes: new Set(), uncertain: [],
  };
  let braces = 0;
  for (let i = 0; i < tokens.length;) {
    if (punct(tokens[i], '{')) { braces++; i++; continue; }
    if (punct(tokens[i], '}')) { braces = Math.max(0, braces - 1); i++; continue; }
    // `import.meta` is an expression, not a static import declaration.
    if (braces === 0 && identifier(tokens[i], 'import') && !punct(tokens[i + 1], '(') && !punct(tokens[i + 1], '.')) { i = parseStaticImport(tokens, i, module); continue; }
    if (braces === 0 && identifier(tokens[i], 'export')) { i = parseExport(tokens, i, module); continue; }
    i++;
  }
  parseCommonJsExports(tokens, module);
  parseRuntimeImports(tokens, module);
  namespaceRequests(tokens, module);
  for (const [name, origins] of module.explicit) {
    module.explicit.set(name, origins.map((origin) => {
      if (origin.kind !== 'local') return origin;
      const imported = module.localImports.get(origin.local);
      return imported ? { kind: 'remote', ...imported } : { kind: 'terminal', symbol: origin.local };
    }));
  }
  module.runtime = [...new Set(module.runtime)];
  module.stars = [...new Set(module.stars)];
  module.cjsStars = [...new Set(module.cjsStars)];
  module.uncertain = [...new Set(module.uncertain)];
  return module;
}

function inside(root, file) {
  const rel = relative(root, file);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function candidateFile(path) {
  try {
    return statSync(path).isFile() ? realpathSync(path) : null;
  } catch {
    return null;
  }
}

function expandBase(base) {
  const extension = extname(base);
  const exact = candidateFile(base);
  if (exact) return [exact];
  if (SCRIPT_FALLBACKS[extension]) {
    const stem = base.slice(0, -extension.length);
    return SCRIPT_FALLBACKS[extension].map((ext) => candidateFile(stem + ext)).filter(Boolean);
  }
  if (extension) return [];
  return [...SOURCE_EXTENSIONS.map((ext) => candidateFile(base + ext)), ...SOURCE_EXTENSIONS.map((ext) => candidateFile(join(base, `index${ext}`)))].filter(Boolean);
}

function aliasMatches(specifier, aliases) {
  const matched = aliases.filter((rule) => rule.wildcard
    ? specifier.startsWith(rule.prefix) && specifier.endsWith(rule.suffix ?? '') && specifier.length >= rule.prefix.length + (rule.suffix?.length ?? 0)
    : specifier === rule.prefix);
  const exact = matched.filter((rule) => !rule.wildcard);
  if (exact.length) return exact;
  const score = Math.max(-1, ...matched.map((rule) => rule.prefix.length + (rule.suffix?.length ?? 0)));
  return matched.filter((rule) => rule.prefix.length + (rule.suffix?.length ?? 0) === score);
}

function issue(code, file, specifier) {
  return { code, file, ...(specifier ? { specifier } : {}) };
}

export function createImportResolver(projectDir, { aliases = [], configFiles = [], limits = {} } = {}) {
  const root = realpathSync(resolve(projectDir));
  const cap = { ...IMPORT_LIMITS, ...limits };
  const parseCache = new Map();

  const rel = (file) => relative(root, file).split(sep).join('/');
  const display = (file) => inside(root, file) ? rel(file) : file;

  function resolveSpecifier(fromFile, specifier) {
    const aliasRules = aliasMatches(specifier, aliases);
    let bases;
    let usedAlias = false;
    if (specifier.startsWith('.')) bases = [resolve(dirname(fromFile), specifier)];
    else if (aliasRules.length) {
      usedAlias = true;
      bases = [];
      for (const rule of aliasRules) {
        const suffix = rule.suffix ?? '';
        const star = rule.wildcard ? specifier.slice(rule.prefix.length, specifier.length - suffix.length) : '';
        for (const target of rule.targets ?? []) {
          const expanded = expandBase(target.replace('*', star));
          if (expanded.length) { bases.push(...expanded); break; } // ordered TS-path fallback
        }
      }
      const unique = [...new Set(bases)];
      if (unique.length > 1) return { status: 'ambiguous', candidates: unique, usedAlias };
      if (unique.length === 1) return { status: 'resolved', file: unique[0], usedAlias };
      return { status: 'missing', candidates: [], usedAlias };
    } else return { status: 'external', candidates: [], usedAlias: false };
    const candidates = [...new Set(bases.flatMap(expandBase))];
    if (candidates.length > 1) return { status: 'ambiguous', candidates, usedAlias };
    if (candidates.length === 1) return { status: 'resolved', file: candidates[0], usedAlias };
    return { status: 'missing', candidates: [], usedAlias };
  }

  function context() {
    return { modules: new Set(), edges: 0, bytes: 0, dependencies: new Set(), issues: [], active: new Set() };
  }

  function addIssue(ctx, code, file, specifier) {
    const value = issue(code, display(file), specifier);
    if (!ctx.issues.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) ctx.issues.push(value);
  }

  function readModule(file, ctx) {
    if (!inside(root, file)) return null;
    if (!ctx.modules.has(file)) {
      if (ctx.modules.size >= cap.maxModules) { addIssue(ctx, 'graph-limit', file); return null; }
      let size;
      try { size = statSync(file).size; } catch { addIssue(ctx, 'unreadable-module', file); return null; }
      if (size > cap.maxFileBytes || ctx.bytes + size > cap.maxTotalBytes) { addIssue(ctx, 'graph-limit', file); return null; }
      ctx.modules.add(file);
      ctx.bytes += size;
    }
    if (parseCache.has(file)) return parseCache.get(file);
    try {
      const parsed = parseModuleSource(readFileSync(file, 'utf8'));
      parseCache.set(file, parsed);
      return parsed;
    } catch {
      addIssue(ctx, 'unsupported-syntax', file);
      return null;
    }
  }

  function step(ctx, from, specifier) {
    if (++ctx.edges > cap.maxEdges) { addIssue(ctx, 'graph-limit', from, specifier); return { status: 'indeterminate' }; }
    // A bare specifier is resolved only after consulting alias configuration.
    // Record that negative consultation too: adding a previously absent alias
    // to an existing config must invalidate an earlier `not-matched` result.
    if (!specifier.startsWith('.')) for (const file of configFiles) ctx.dependencies.add(resolve(root, file));
    const resolved = resolveSpecifier(from, specifier);
    if (resolved.status === 'ambiguous') {
      addIssue(ctx, 'ambiguous-resolution', from, specifier);
      return { status: 'indeterminate', candidates: resolved.candidates };
    }
    if (resolved.status === 'missing') {
      addIssue(ctx, 'unreadable-module', from, specifier);
      return { status: 'indeterminate' };
    }
    return resolved.status === 'resolved' && inside(root, resolved.file) ? resolved : { status: 'external' };
  }

  function origin(file, symbol, target, ctx, depth, path) {
    if (depth > cap.maxDepth) { addIssue(ctx, 'graph-limit', file); return { origins: new Map(), cycle: false }; }
    if (file === target) return { origins: new Map([[`${file}#${symbol}`, [...path, file]]]), cycle: false };
    const key = `${file}\0${symbol}`;
    if (ctx.active.has(key)) return { origins: new Map(), cycle: true };
    const parsed = readModule(file, ctx);
    if (!parsed) return { origins: new Map(), cycle: false };
    ctx.dependencies.add(file);
    ctx.active.add(key);
    let origins = new Map();
    let cycle = false;
    const explicit = parsed.explicit.get(symbol);
    const candidates = explicit ?? (symbol === 'default' ? [] : [
      ...parsed.stars.map((specifier) => ({ kind: 'remote', specifier, imported: symbol })),
      ...parsed.cjsStars.map((specifier) => ({ kind: 'remote', specifier, imported: symbol })),
    ]);
    for (const candidate of candidates) {
      if (candidate.kind === 'terminal') {
        origins.set(`${file}#${candidate.symbol}`, [...path, file]);
        continue;
      }
      const next = step(ctx, file, candidate.specifier);
      if (next.status === 'indeterminate') continue;
      if (next.status !== 'resolved') continue;
      if (candidate.kind === 'namespace') {
        if (next.file === target) origins.set(`${target}#*`, [...path, file, target]);
        else {
          const reached = runtimeReach(next.file, target, ctx, depth + 1, [...path, file], new Set());
          if (Array.isArray(reached)) origins.set(`${target}#*`, reached);
          else if (reached === false) origins.set(`${next.file}#*`, [...path, file, next.file]);
        }
        continue;
      }
      const found = origin(next.file, candidate.imported, target, ctx, depth + 1, [...path, file]);
      for (const [id, witness] of found.origins) origins.set(id, witness);
      cycle ||= found.cycle;
    }
    if (!explicit?.length && candidates.length === 0 && parsed.uncertain.length) addIssue(ctx, 'unsupported-syntax', file);
    ctx.active.delete(key);
    return { origins, cycle };
  }

  function runtimeReach(file, target, ctx, depth, path, visited) {
    if (depth > cap.maxDepth) { addIssue(ctx, 'graph-limit', file); return null; }
    if (file === target) return [...path, file];
    if (visited.has(file)) return false;
    visited.add(file);
    const parsed = readModule(file, ctx);
    if (!parsed) return null;
    ctx.dependencies.add(file);
    let unknown = parsed.uncertain.length > 0;
    for (const specifier of parsed.runtime) {
      const next = step(ctx, file, specifier);
      if (next.status === 'indeterminate') { unknown = true; continue; }
      if (next.status !== 'resolved') continue;
      const found = runtimeReach(next.file, target, ctx, depth + 1, [...path, file], visited);
      if (Array.isArray(found)) return found;
      if (found === null) unknown = true;
    }
    return unknown ? null : false;
  }

  function evaluateRequest(importer, request, target, ctx) {
    const next = step(ctx, importer, request.specifier);
    if (next.status === 'indeterminate') {
      const outcomes = (next.candidates ?? []).map((file) => {
        if (request.mode === 'unknown-namespace') {
          const reached = runtimeReach(file, target, ctx, 1, [importer], new Set());
          return { status: Array.isArray(reached) ? 'unknown' : reached === null ? 'unknown' : 'other', paths: [] };
        }
        if (file === target) return { status: 'match', paths: [[importer, target]] };
        if (request.mode === 'runtime') {
          const reached = runtimeReach(file, target, ctx, 1, [importer], new Set());
          return { status: Array.isArray(reached) ? 'match' : reached === null ? 'unknown' : 'other', paths: Array.isArray(reached) ? [reached] : [] };
        }
        const result = origin(file, request.symbol, target, ctx, 1, [importer]);
        const witnesses = [...result.origins].filter(([id]) => id.startsWith(`${target}#`)).map(([, witness]) => witness);
        return { status: witnesses.length === 1 && result.origins.size === 1 ? 'match' : result.origins.size > 1 || result.cycle ? 'unknown' : 'other', paths: witnesses };
      });
      return outcomes.length && outcomes.every((value) => value.status === 'match')
        ? { status: 'matched', paths: outcomes.flatMap((value) => value.paths) }
        : { status: 'indeterminate', paths: [] };
    }
    if (next.status !== 'resolved') return { status: 'not-matched', paths: [] };
    if (request.mode === 'unknown-namespace') {
      const reached = runtimeReach(next.file, target, ctx, 1, [importer], new Set());
      return Array.isArray(reached) || reached === null ? { status: 'indeterminate', paths: [] } : { status: 'not-matched', paths: [] };
    }
    if (next.file === target) return { status: 'matched', paths: [[importer, target]] };
    if (request.mode === 'runtime') {
      const reached = runtimeReach(next.file, target, ctx, 1, [importer], new Set());
      return Array.isArray(reached) ? { status: 'matched', paths: [reached] } : { status: reached === null ? 'indeterminate' : 'not-matched', paths: [] };
    }
    const found = origin(next.file, request.symbol, target, ctx, 1, [importer]);
    if (found.origins.size > 1) {
      addIssue(ctx, 'ambiguous-resolution', next.file, request.symbol);
      return { status: 'indeterminate', paths: [] };
    }
    if (found.origins.size === 1) {
      const [id, witness] = [...found.origins][0];
      return id.startsWith(`${target}#`) ? { status: 'matched', paths: [witness] } : { status: 'not-matched', paths: [] };
    }
    if (found.cycle) {
      addIssue(ctx, 'cyclic-export-without-origin', next.file, request.symbol);
      return { status: 'indeterminate', paths: [] };
    }
    return ctx.issues.length ? { status: 'indeterminate', paths: [] } : { status: 'not-matched', paths: [] };
  }

  function relation(absImporter, targetRel) {
    let importer;
    try { importer = realpathSync(resolve(absImporter)); }
    catch { return { status: 'indeterminate', bindings: [], paths: [], dependencies: [], reason: 'unreadable-module', issues: [issue('unreadable-module', display(resolve(absImporter)))] }; }
    const targetPath = resolve(root, targetRel);
    if (!existsSync(targetPath)) return { status: 'indeterminate', bindings: [], paths: [], dependencies: [], reason: 'unreadable-module', issues: [issue('unreadable-module', targetRel)] };
    const target = realpathSync(targetPath);
    const ctx = context();
    const parsed = readModule(importer, ctx);
    if (!parsed) return finish('indeterminate', [], [], ctx);
    if (parsed.uncertain.length) addIssue(ctx, 'unsupported-syntax', importer);
    const paths = [];
    const bindings = new Set();
    let indeterminate = parsed.uncertain.length > 0;
    for (const request of parsed.requests) {
      const result = evaluateRequest(importer, request, target, ctx);
      if (result.status === 'matched') {
        paths.push(...result.paths);
        if (request.local) bindings.add(request.local);
      } else if (result.status === 'indeterminate') indeterminate = true;
    }
    if (paths.length && !parsed.uncertain.length) return finish('matched', [...bindings], paths, ctx);
    return finish(indeterminate ? 'indeterminate' : 'not-matched', [], [], ctx);
  }

  function finish(status, bindings, paths, ctx) {
    const normalizedPaths = [];
    const seen = new Set();
    for (const path of paths) {
      const normalized = path.map(display);
      const key = normalized.join('\0');
      if (!seen.has(key) && normalizedPaths.length < cap.maxWitnessPaths) { seen.add(key); normalizedPaths.push(normalized); }
    }
    const dependencies = [...ctx.dependencies]
      .filter((file) => inside(root, file))
      .map(rel)
      .sort();
    const issues = [...ctx.issues].sort((a, b) => `${a.file}\0${a.code}\0${a.specifier ?? ''}`.localeCompare(`${b.file}\0${b.code}\0${b.specifier ?? ''}`));
    return {
      status,
      bindings: [...new Set(bindings)].sort(),
      paths: normalizedPaths.sort((a, b) => a.join('\0').localeCompare(b.join('\0'))),
      dependencies,
      ...(status === 'indeterminate' ? { reason: issues[0]?.code ?? 'unsupported-syntax' } : {}),
      ...(issues.length ? { issues } : {}),
    };
  }

  return { relation, resolveSpecifier };
}

/** Convenience for callers that do not need to share the resolver's parse cache. */
export function fileImportRelation(projectDir, absImporter, targetRel, options) {
  return createImportResolver(projectDir, options).relation(absImporter, targetRel);
}
