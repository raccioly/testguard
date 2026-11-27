/**
 * Mechanical fault producers for Java (#329, #333). Deterministic, line
 * oriented, no AST, no LLM: the same contract as `producers.mjs`, written for
 * the syntax the file is in. Shared by the `maven` and `gradle` adapters, which
 * export it as `producers`.
 *
 * Every proposal must still compile: a replacement that does not is a
 * `fault-invalid` verdict, a probe run that says nothing about the tests. So
 * the set is small, and each shape refuses what it cannot make safe:
 *
 *   condition-forced   `if (<cond>) {` becomes `if (false) {` and `if (true) {`.
 *                      Java accepts both (`if` is exempt from the unreachable
 *                      statement rule). Refused for `instanceof Type binding`:
 *                      the binding would no longer be defined.
 *   statement-deleted  a single-line `if (<cond>) return|throw|continue|break;`
 *                      removed, the null guard being the common case.
 *   call-removed       `Objects.requireNonNull(x);` removed.
 *   return-altered     `return <literal>;` altered (a number to 0, 0 to 1, a
 *                      string to "", a boolean flipped), and `return <boolean
 *                      check>;` to `return true;`. Never a ternary.
 *   literal-changed    one boolean literal swapped, except in loop headers,
 *                      annotations and asserts, where a swap does not compile
 *                      or says nothing.
 *   argument-swapped   a parameter-derived first argument swapped for `null`,
 *                      for reference-typed parameters only: `null` does not
 *                      compile for a primitive.
 *
 * The JavaScript shapes with no Java meaning (`undefined`, JSX element and
 * handler removal, object field drops) are absent rather than faked.
 */

const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;
const ANNOTATION_LINE = /^\s*@/;
const BLOCK_IF = /^(\s*)(?:\}\s*)?(?:else\s+)?if\s*\((.+)\)\s*\{\s*$/;
const LINE_IF = /^(\s*)(?:else\s+)?if\s*\((.+)\)\s*(?:return\b[^;]*|throw\b[^;]*|continue|break)\s*;\s*$/;
const INSTANCEOF_BINDING = /\binstanceof\s+(?:final\s+)?[\w$.<>?,\[\]\s]*?[\w$>\]]\s+[a-z_$][\w$]*\s*(?:\)|&&|\|\||$)/;
const REQUIRE_NON_NULL = /^\s*(?:Objects\.)?requireNonNull\s*\(.*\)\s*;\s*$/;
const NULL_CHECK = /^\s*(?:[\w$.]+\s*==\s*null|null\s*==\s*[\w$.]+)\s*$/;
const RETURN = /^(\s*)return\s+(.+?)\s*;\s*$/;
const NUMBER = /^-?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[lLfFdD]?$/;
const STRING = /^"(?:[^"\\]|\\.)*"$/;
const BOOLEAN_CHECK = /(?:==|!=|<=|>=|&&|\|\||\binstanceof\b|\.equals\(|\.equalsIgnoreCase\(|\.startsWith\(|\.endsWith\(|\.contains\(|\.matches\(|\.isEmpty\(\)|^!)/;
const LOOP_OR_ASSERT = /^\s*(?:while|for|do|assert)\b/;
const BOOLEAN_LITERAL = /\b(?:true|false)\b/;
const CALL_WITH_ARG = /(?<![\w$.])(?<!\bnew\s+)([\w$]+(?:\.[\w$]+)*)\(\s*([\w$]+(?:\.[\w$]+)*(?:\([^()]*\))?)\s*(?=,|\))/g;
const NOT_A_CALL = /^(?:if|for|while|switch|catch|return|synchronized|assert|super|this|new|throw|try)$/;
const NOT_A_TARGET = /(?:^|\.)(?:println|print|printf|format|valueOf|info|debug|warn|error|trace|log|requireNonNull|hash|equals|hashCode|toString|of|asList)$|^(?:Objects|Assert|Assertions|String|Math|Arrays|Collections|System|log|logger|LOG|LOGGER)\./;
const PRIMITIVE = /^(?:int|long|short|byte|char|boolean|float|double)$/;
const MODIFIERS = '(?:(?:public|protected|private|static|final|abstract|synchronized|default|native|strictfp)\\s+)*';
const METHOD_HEAD = new RegExp(`^\\s*${MODIFIERS}(?:<[^>]+>\\s+)?[\\w$.<>\\[\\],? ]+?\\s+([\\w$]+)\\s*\\(([^)]*)\\)\\s*(?:throws\\s+[\\w$.,\\s]+)?\\{\\s*$`);
const CONSTRUCTOR_HEAD = /^\s*(?:public|protected|private)\s+([A-Z][\w$]*)\s*\(([^)]*)\)\s*(?:throws\s+[\w$.,\s]+)?\{\s*$/;
const NOT_A_FUNCTION = new Set(['if', 'for', 'while', 'switch', 'catch', 'else', 'return', 'new', 'throw', 'try', 'synchronized', 'do']);
const NOT_A_TYPE = new Set(['else', 'return', 'new', 'throw', 'case', 'default', 'yield']);

/** The method or constructor a declaration line opens, or null. One-line declarations only. */
export function javaFunctionHead(line) {
  const ctor = CONSTRUCTOR_HEAD.exec(line);
  if (ctor) return ctor[1];
  const m = METHOD_HEAD.exec(line);
  if (!m || NOT_A_FUNCTION.has(m[1])) return null;
  const before = line.slice(0, line.indexOf(`${m[1]}(`)).trim().split(/\s+/).pop();
  return before && NOT_A_TYPE.has(before) ? null : m[1];
}

/** Split on commas that are not inside `<...>` generics. */
function splitParameters(inner) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; } else current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * The reference-typed parameters of a declaration line. A primitive parameter
 * is left out on purpose: `null` does not compile where an `int` is expected.
 */
export function javaFunctionParams(line) {
  const m = METHOD_HEAD.exec(line) ?? CONSTRUCTOR_HEAD.exec(line);
  if (!m) return [];
  const names = [];
  for (const raw of splitParameters(m[2])) {
    const declaration = raw.replace(/@[\w$.]+(?:\([^)]*\))?\s*/g, '').replace(/\bfinal\s+/g, '').trim();
    const parts = /^(.+?)\s+([\w$]+)$/.exec(declaration);
    if (!parts) continue;
    const [, type, name] = parts;
    if (PRIMITIVE.test(type.trim())) continue;
    names.push(name);
  }
  return names;
}

export const javaIsComment = (line) => COMMENT.test(line);

/** `line` with string literals blanked, so a quote never hides or fakes code. */
const withoutStrings = (line) => line.replace(/"(?:[^"\\]|\\.)*"/g, (s) => '"' + ' '.repeat(s.length - 2) + '"').replace(/'(?:[^'\\]|\\.)'/g, (s) => `'${' '.repeat(s.length - 2)}'`);

function literalReturn(literal) {
  if (literal === 'true') return { to: 'false', what: 'false' };
  if (literal === 'false') return { to: 'true', what: 'true' };
  if (NUMBER.test(literal)) {
    const zero = Number(literal.replace(/_/g, '').replace(/[lLfFdD]$/, '')) === 0;
    return { to: zero ? '1' : '0', what: zero ? '1' : '0' };
  }
  if (STRING.test(literal)) return literal === '""' ? { to: '"x"', what: '"x"' } : { to: '""', what: 'an empty string' };
  return null;
}

function conditionProposals(lines, i) {
  const line = lines[i];
  const m = BLOCK_IF.exec(line);
  if (!m) return null;
  const cond = m[2];
  if (INSTANCEOF_BINDING.test(withoutStrings(cond))) return [];
  const swap = (value) => line.replace(`(${cond})`, () => `(${value})`);
  return [
    { faultClass: 'condition-forced', description: `Condition never true: \`if (${cond.trim()})\` becomes \`if (false)\`.`, replace: swap('false') },
    { faultClass: 'condition-forced', description: `Condition always true: \`if (${cond.trim()})\` becomes \`if (true)\`.`, replace: swap('true') },
  ];
}

function guardProposals(line) {
  const m = LINE_IF.exec(line);
  if (!m) return null;
  const nullGuard = NULL_CHECK.test(m[2]);
  return [{
    faultClass: 'statement-deleted',
    description: nullGuard ? `Null guard removed: \`${line.trim()}\` no longer runs.` : `Guard removed: \`${line.trim()}\` no longer runs.`,
    replace: '',
  }];
}

function returnProposals(line) {
  const m = RETURN.exec(line);
  if (!m) return [];
  const [, indent, expr] = m;
  const literal = literalReturn(expr);
  if (literal) return [{ faultClass: 'return-altered', description: `Return value changed: \`return ${expr};\` becomes \`return ${literal.to};\`.`, replace: `${indent}return ${literal.to};` }];
  const plain = withoutStrings(expr);
  if (!plain.includes('?') && BOOLEAN_CHECK.test(plain)) {
    return [{ faultClass: 'return-altered', description: `Check always passes: \`return ${expr};\` becomes \`return true;\`.`, replace: `${indent}return true;` }];
  }
  return [];
}

function booleanProposals(line) {
  if (ANNOTATION_LINE.test(line) || LOOP_OR_ASSERT.test(line) || BLOCK_IF.test(line) || LINE_IF.test(line) || RETURN.test(line)) return [];
  const plain = withoutStrings(line);
  const at = plain.search(BOOLEAN_LITERAL);
  if (at === -1) return [];
  const literal = /^(true|false)/.exec(plain.slice(at))[1];
  const flipped = literal === 'true' ? 'false' : 'true';
  return [{ faultClass: 'literal-changed', description: `Boolean literal swapped: \`${literal}\` becomes \`${flipped}\`.`, replace: `${line.slice(0, at)}${flipped}${line.slice(at + literal.length)}` }];
}

function argumentProposals(line, params) {
  if (!params?.size) return [];
  const out = [];
  const seen = new Set();
  const head = javaFunctionHead(line);
  for (const m of withoutStrings(line).matchAll(CALL_WITH_ARG)) {
    const [whole, callee, arg] = m;
    if (NOT_A_CALL.test(callee) || NOT_A_TARGET.test(callee) || callee === head) continue;
    const root = /^[\w$]+/.exec(arg)[0];
    if (!params.has(root) || seen.has(whole)) continue;
    seen.add(whole);
    const original = line.slice(m.index, m.index + whole.length);
    out.push({
      faultClass: 'argument-swapped',
      description: `Argument swapped: \`${callee}(${arg}, …)\` is called with \`null\` instead of the derived value.`,
      replace: line.replace(original, () => `${callee}(null`),
    });
  }
  return out;
}

/** Proposals for one line: `{ faultClass, description, replace }`, `find` being the line itself. */
export function javaProposalsForLine(lines, i, ctx = {}) {
  const line = lines[i];
  if (!line.trim() || COMMENT.test(line)) return [];
  const block = conditionProposals(lines, i);
  if (block !== null) return block;
  const guard = guardProposals(line);
  if (guard !== null) return guard;
  if (REQUIRE_NON_NULL.test(line)) return [{ faultClass: 'call-removed', description: `Null check removed: \`${line.trim()}\` no longer runs.`, replace: '' }];
  return [...returnProposals(line), ...booleanProposals(line), ...argumentProposals(line, ctx.params)];
}

export const javaProducers = Object.freeze({
  extensions: Object.freeze(['.java']),
  proposalsForLine: javaProposalsForLine,
  functionHead: javaFunctionHead,
  functionParams: javaFunctionParams,
  isComment: javaIsComment,
});
