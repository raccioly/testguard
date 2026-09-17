/**
 * Mechanical fault producers. Deterministic, line-oriented, no AST, no LLM.
 *
 * Field reports found that most hand-written faults are one of a few shapes.
 * Each producer looks at one line (plus a little context) and proposes a
 * fault whose `find` is the exact line, so the anchor hits by construction.
 * A human keeps or drops every proposal.
 *
 * Shapes:
 *   condition-forced   `if (<guard>) {` → `if (false) {`
 *   statement-deleted  a single-line guard or a state change removed
 *   return-altered     `return <check>;` → `return true;`
 *   literal-changed    a security flag / window / cost literal weakened
 *   call-removed       a bare verify/validate/check call removed
 *   field-dropped      a field removed from a persisted or transmitted object,
 *                      an allow-list, a schema, or a spread merge (issue #14)
 *   argument-swapped   a call kept, its parameter-derived argument swapped for
 *                      a trivial value (issue #22)
 *   element-removed    a one-line JSX element (self-closing or paired) removed
 *                      (issue #15)
 *   handler-dropped    an on<Event>={…} prop removed from a JSX element
 *                      (issue #15)
 */

const COMMENT = /^\s*(\/\/|\*|\/\*)/;
const GUARD_BODY = /\b(return|throw)\b|\.status\(\s*4\d\d|\bredirect\(|\bfalse\b|\bnull\b/;
const IF_LINE = /^(\s*)(?:\}\s*)?(?:else\s+)?if\s*\((.+)\)\s*(\{\s*|(?:return|throw)\b.*;\s*)?$/;
const RETURN_CHECK = /^\s*return\s+(.+);\s*$/;
const CHECK_EXPR = /(===|!==|\.includes\(|\.has\(|\.some\(|\.every\(|\.test\(|\.startsWith\(|\.endsWith\(|\binstanceof\b|&&|\|\||^!)/;
const CHECK_CALL = /^\s*(?:await\s+)?(?:[\w$]+\.)*(verify|validate|assert|check|require|ensure|authoriz|authentic|rateLimit|throttle|enforce|guard)\w*\s*\(.*\)\s*;\s*$/i;
const MUTATION = /^\s*(?!(?:const|let|var|return|if|for|while|else|switch|case|import|export|throw)\b)[\w$]+(?:[.\[][\w$'"\]]+)*\s*(=|\+=|-=|\|\|=|&&=|\?\?=)\s*(?!=)[^;]*;\s*$/;
const FLAG_TRUE = /\b(httpOnly|secure|signed|requireTLS|rejectUnauthorized|strict)\s*:\s*true\b/;
const SAME_SITE = /\bsameSite\s*:\s*(['"])(strict|lax)\1/i;
const COST_NUM = /\b(\w*(?:cost|rounds|iterations)\w*)\s*([:=])\s*(\d+)\b/i;
const WINDOW_NUM = /\b(\w*(?:ttl|expir|tolerance|window|maxAge|max_age|timeout|limit|attempts|length|minLength|clockSkew|skew)\w*)\s*([:=])\s*(\d+)\b/i;
const FUNCTION_HEAD = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?function\b/,
  /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?([\w$]+)\s*\([^)]*\)\s*(?::\s*[\w<>\[\]| ]+)?\s*\{\s*$/,
];
const NOT_A_FUNCTION = new Set(['if', 'for', 'while', 'switch', 'catch', 'else', 'return', 'function', 'constructor']);

// ── field-dropped ──
// An object literal counts as a payload when its opening line says so: it is
// returned, built by an arrow, assigned to a payload-ish name, passed to a
// persistence/transport call, or is a validation schema. Type-level braces
// (`interface`, `type X = {`) are never payloads: dropping a key there is a
// compile error, not a behaviour.
const PAYLOAD_OPENER = /(\breturn\s*\{\s*$|=>\s*\(?\s*\{\s*$|\b(?:body|payload|input|item|params|data|record|row|attrs|attributes|values|fields|patch|update|updates|changes|doc|document|entity|dto|request|response|options|args|props|config|settings|message|event|entry|audit)\w*\s*[:=]\s*\{\s*$|\.(?:save|update|put|patch|post|send|write|insert|upsert|create|set|publish|emit|dispatch|persist|store|log|fetch|request|audit|record|track|notify)\w*\s*\(\s*(?:[^,{]*,\s*)*\{\s*$|\b(?:z|yup|joi|v|t)\.(?:object|shape|strictObject|looseObject)\s*\(\s*\{\s*$|\.(?:object|shape|extend|merge|pick|omit)\s*\(\s*\{\s*$|\bobject\s*\(\s*\{\s*$)/i;
const TYPE_OPENER = /\b(?:interface|type|enum|declare)\b/;
const ALLOWLIST_OPENER = /\b\w*(?:fields|keys|allowed|writable|columns|attributes|props|whitelist|allowlist|editable|mutable|updatable|permitted|selectable|sortable|filterable|required)\w*\b[^[]*\[\s*$/i;
const PROP_LINE = /^\s*(?:[\w$]+|'[^']*'|"[^"]*"|\[[^\]]+\])\s*:\s*(?!\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>))(.+?)(,?)\s*$/;
const SHORTHAND_LINE = /^\s*[\w$]+\s*,\s*$/;
const METHOD_LINE = /^\s*(?:async\s+)?(?:get\s+|set\s+)?[\w$]+\s*\([^)]*\)\s*\{\s*$/;
const SPREAD_LINE = /^\s*\.\.\.[\w$.()]+\s*,?\s*$/;
const STRING_ENTRY = /^\s*(['"])[^'"]+\1\s*,?\s*$/;
const INLINE_SPREAD_MERGE = /\{\s*\.\.\.([\w$.()]+)\s*,\s*(?=[^}]*\S)/;

// ── element-removed / handler-dropped (JSX) ──
// One-line elements only, so the removal is syntactically safe by construction.
const JSX_SELF_CLOSING = /^\s*<[A-Za-z][\w.-]*\b[^<>]*\/>\s*$/;
const JSX_PAIRED_LINE = /^\s*<([A-Za-z][\w.-]*)\b[^<>]*>[^<>]*<\/\1>\s*$/;
const JSX_HANDLER_PROP_LINE = /^\s*on[A-Z]\w*=\{(?:[^{}]|\{[^{}]*\})*\}\s*$/;
const JSX_INLINE_HANDLER = /\s+on[A-Z]\w*=\{(?:[^{}]|\{[^{}]*\})*\}/;

// ── argument-swapped ──
// A call whose first argument is derived from a parameter or a request-like
// value. `callee(` must not be a keyword, a constructor, an import, or a test
// helper; the argument must not be a literal.
const CALL_WITH_ARG = /(?<![\w$.])(?<!\bnew\s+)(?!(?:if|for|while|switch|catch|return|function|typeof|await|new|require|import|expect|describe|it|test|vi|jest|console|logger)\b)([\w$]+(?:\.[\w$]+)*)\(\s*((?:[\w$]+(?:\?\.|\.)[\w$?.]+)|(?:[\w$]+\([^()]*\))|(?:[\w$]+))\s*(?=,|\))/g;
const REQUEST_LIKE = /^(?:req|request|res|ctx|context|event|input|args|params|options|opts|props|state|session|user|payload|body|query|headers|msg|message|job|task)$/;

/** Name of the function whose head is on this line, or null. */
export function functionHead(line) {
  for (const re of FUNCTION_HEAD) {
    const m = re.exec(line);
    if (m && !NOT_A_FUNCTION.has(m[1])) return m[1];
  }
  return null;
}

/**
 * Parameter names declared on a function-head line: plain, defaulted,
 * typed, rest, and the leaves of one level of destructuring. Best effort.
 */
export function functionParams(line) {
  const open = line.indexOf('(');
  const arrow = line.indexOf('=>');
  if (open === -1 || (arrow !== -1 && arrow < open)) {
    // `const f = x => …` style: a bare identifier before `=>`
    const bare = /=\s*(?:async\s+)?([\w$]+)\s*=>/.exec(line);
    return bare ? [bare[1]] : [];
  }
  let depth = 0;
  let close = -1;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')' && --depth === 0) { close = i; break; }
  }
  if (close === -1) return [];
  const inner = line.slice(open + 1, close);
  const names = [];
  for (const raw of inner.split(/,(?![^{[]*[}\]])/)) {
    let p = raw.trim();
    if (!p) continue;
    p = p.replace(/^\.\.\./, '').replace(/\s*=[\s\S]*$/, '').replace(/\s*:[^,{}]*$/, '').replace(/\?$/, '');
    const destructured = /^[{[]([\s\S]*)[}\]]$/.exec(p);
    if (destructured) {
      for (const part of destructured[1].split(',')) {
        const leaf = part.trim().replace(/^\.\.\./, '').split(/\s*[:=]\s*/).pop().trim();
        if (/^[\w$]+$/.test(leaf)) names.push(leaf);
      }
    } else if (/^[\w$]+$/.test(p)) {
      names.push(p);
    }
  }
  return names;
}

function isGuard(cond, lines, i) {
  if (/^\s*!/.test(cond)) return true;
  const tail = lines.slice(i, i + 4).join('\n');
  return GUARD_BODY.test(tail);
}

const openerCache = new WeakMap();

/**
 * For every line, the innermost bracket left open before that line starts:
 * `{ line, char }` or null. One forward pass with a stack; strings and
 * comments are not parsed (deterministic heuristic, like everything here).
 */
export function openerIndex(lines) {
  if (openerCache.has(lines)) return openerCache.get(lines);
  const out = new Array(lines.length);
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    out[i] = stack.length ? stack[stack.length - 1] : null;
    const line = lines[i];
    if (COMMENT.test(line)) continue;
    for (const ch of line) {
      if (ch === '{' || ch === '[' || ch === '(') stack.push({ line: i, char: ch });
      else if (ch === '}' || ch === ']' || ch === ')') stack.pop();
    }
  }
  openerCache.set(lines, out);
  return out;
}

const balanced = (line) => {
  const n = (re) => (line.match(re) ?? []).length;
  return n(/\{/g) === n(/\}/g) && n(/\[/g) === n(/\]/g) && n(/\(/g) === n(/\)/g);
};

/** A line that can be removed on its own: balanced, and either comma-terminated or followed by the closer. */
function removableAlone(lines, i) {
  const line = lines[i];
  if (!balanced(line)) return false;
  if (/,\s*$/.test(line)) return true;
  for (let j = i + 1; j < lines.length; j++) {
    if (!lines[j].trim()) continue;
    return /^\s*[}\])]/.test(lines[j]);
  }
  return false;
}

function fieldDropProposals(lines, i) {
  const line = lines[i];
  const out = [];
  const opener = openerIndex(lines)[i];
  const openerLine = opener ? lines[opener.line] : '';
  const inPayload = opener?.char === '{' && PAYLOAD_OPENER.test(openerLine) && !TYPE_OPENER.test(openerLine);
  const inAllowList = opener?.char === '[' && ALLOWLIST_OPENER.test(openerLine);

  if (inPayload && !METHOD_LINE.test(line) && removableAlone(lines, i)) {
    const schema = /\b(?:z|yup|joi|v|t)\.|\.(?:object|shape|extend|merge|pick|omit)\s*\(|\bobject\s*\(/i.test(openerLine);
    if (SPREAD_LINE.test(line)) {
      out.push({ faultClass: 'field-dropped', description: `Base object dropped from the merge: \`${line.trim()}\` no longer contributes its fields.`, replace: '' });
    } else if (PROP_LINE.test(line) || SHORTHAND_LINE.test(line)) {
      const name = line.trim().replace(/[,:].*$/, '').replace(/^['"[]|['"\]]$/g, '');
      out.push({ faultClass: 'field-dropped', description: schema ? `Field dropped from the schema: \`${name}\` is no longer validated or serialised.` : `Field dropped: \`${name}\` is no longer written.`, replace: '' });
    }
  } else if (inAllowList && STRING_ENTRY.test(line) && removableAlone(lines, i)) {
    out.push({ faultClass: 'field-dropped', description: `Field dropped from the allow-list: ${line.trim().replace(/,\s*$/, '')} is no longer permitted.`, replace: '' });
  }

  const merge = INLINE_SPREAD_MERGE.exec(line);
  if (merge) {
    out.push({ faultClass: 'field-dropped', description: `Base object dropped from the inline merge: \`...${merge[1]}\` no longer contributes its fields.`, replace: line.replace(merge[0], '{ ') });
  }
  return out;
}

function jsxProposals(lines, i) {
  const line = lines[i];
  const out = [];
  if (JSX_SELF_CLOSING.test(line) || JSX_PAIRED_LINE.test(line)) {
    const tag = /<([A-Za-z][\w.-]*)/.exec(line)[1];
    out.push({ faultClass: 'element-removed', description: `Element removed: \`<${tag}>\` is no longer rendered.`, replace: '' });
  }
  if (JSX_HANDLER_PROP_LINE.test(line)) {
    const name = /on[A-Z]\w*/.exec(line)[0];
    out.push({ faultClass: 'handler-dropped', description: `Handler dropped: \`${name}\` is no longer wired.`, replace: '' });
  } else {
    const m = JSX_INLINE_HANDLER.exec(line);
    if (m && /<[A-Za-z]/.test(line)) {
      const name = /on[A-Z]\w*/.exec(m[0])[0];
      out.push({ faultClass: 'handler-dropped', description: `Handler dropped: \`${name}\` is no longer wired.`, replace: line.replace(m[0], '') });
    }
  }
  return out;
}

function isDerived(arg, params) {
  const idents = arg.match(/[\w$]+/g) ?? [];
  if (idents.some((id) => params.has(id))) return true;
  const head = /^([\w$]+)/.exec(arg)?.[1] ?? '';
  return REQUEST_LIKE.test(head) || arg === 'this' || /^this[.?]/.test(arg);
}

function argumentSwapProposals(lines, i, params) {
  const line = lines[i];
  const out = [];
  const head = functionHead(line);
  const seen = new Set();
  for (const m of line.matchAll(CALL_WITH_ARG)) {
    const [whole, callee, arg] = m;
    if (head && callee.split('.').pop() === head) continue; // the head of a declaration, not a call
    if (/^(?:'|"|`|\d|true$|false$|null$|undefined$)/.test(arg)) continue;
    if (!isDerived(arg, params)) continue;
    if (seen.has(whole)) continue;
    seen.add(whole);
    const swap = (value) => line.replace(whole, `${callee}(${value}`);
    out.push({ faultClass: 'argument-swapped', description: `Argument swapped: \`${callee}(${arg}, …)\` is called with \`undefined\` instead of the derived value.`, replace: swap('undefined') });
    if (/\(/.test(arg)) out.push({ faultClass: 'argument-swapped', description: `Argument swapped: \`${callee}(${arg}, …)\` is called with an empty object instead of the derived value.`, replace: swap('{}') });
  }
  return out;
}

/**
 * Proposals for one line. Each: { faultClass, description, replace } where
 * find is the line itself. `ctx.params` is the enclosing function's parameter
 * set (for argument-swapped); `ctx.fieldDrops = false` disables the
 * data/UI shapes — field-dropped, element-removed, handler-dropped — for
 * test files, fixtures and migrations, where an object or element is data,
 * not the product's output.
 */
export function proposalsForLine(lines, i, ctx = {}) {
  const line = lines[i];
  const out = [];
  if (!line.trim() || COMMENT.test(line)) return out;
  const params = ctx.params ?? new Set();

  const ifm = IF_LINE.exec(line);
  if (ifm && isGuard(ifm[2], lines, i)) {
    const singleLine = ifm[3] && /^(return|throw)\b/.test(ifm[3].trim());
    if (singleLine) {
      out.push({ faultClass: 'statement-deleted', description: `Guard removed: \`${line.trim()}\` no longer runs.`, replace: '' });
    } else {
      out.push({ faultClass: 'condition-forced', description: `Guard never triggers: \`if (${ifm[2].trim()})\` becomes \`if (false)\`.`, replace: line.replace(`(${ifm[2]})`, '(false)') });
    }
    return out; // an `if` line is not also a mutation/return/call
  }

  const rm = RETURN_CHECK.exec(line);
  if (rm && CHECK_EXPR.test(rm[1]) && !/^(new|await)\b/.test(rm[1].trim())) {
    out.push({ faultClass: 'return-altered', description: `Check always passes: \`return ${rm[1].trim()}\` becomes \`return true\`.`, replace: line.replace(/return\s+.+;/, 'return true;') });
  }

  if (CHECK_CALL.test(line)) {
    out.push({ faultClass: 'call-removed', description: `Check call removed: \`${line.trim()}\` no longer runs.`, replace: '' });
  } else if (MUTATION.test(line)) {
    out.push({ faultClass: 'statement-deleted', description: `State change removed: \`${line.trim()}\` no longer runs.`, replace: '' });
  }

  let m;
  if ((m = FLAG_TRUE.exec(line))) {
    out.push({ faultClass: 'literal-changed', description: `Security flag flipped: \`${m[1]}: true\` becomes \`${m[1]}: false\`.`, replace: line.replace(m[0], `${m[1]}: false`) });
  }
  if ((m = SAME_SITE.exec(line))) {
    out.push({ faultClass: 'literal-changed', description: `sameSite weakened: \`${m[2]}\` becomes \`none\`.`, replace: line.replace(m[0], `sameSite: ${m[1]}none${m[1]}`) });
  }
  if ((m = COST_NUM.exec(line))) {
    out.push({ faultClass: 'literal-changed', description: `Work factor collapsed: \`${m[1]}\` ${m[3]} becomes 1.`, replace: line.replace(m[0], `${m[1]}${m[2] === ':' ? ': ' : ' = '}1`) });
  } else if ((m = WINDOW_NUM.exec(line))) {
    out.push({ faultClass: 'literal-changed', description: `Window widened ×1000: \`${m[1]}\` ${m[3]} becomes ${Number(m[3]) * 1000}.`, replace: line.replace(m[0], `${m[1]}${m[2] === ':' ? ': ' : ' = '}${Number(m[3]) * 1000}`) });
  }

  if (ctx.fieldDrops !== false) {
    out.push(...fieldDropProposals(lines, i));
    out.push(...jsxProposals(lines, i));
  }
  out.push(...argumentSwapProposals(lines, i, params));
  return out;
}
