/**
 * Mechanical fault producers. Deterministic, line-oriented, no AST, no LLM.
 *
 * Two independent field reports found that ~80% of hand-written faults are
 * one of these shapes. Each producer looks at one line (plus a little
 * context) and proposes a fault whose `find` is the exact line, so the anchor
 * hits by construction. A human keeps or drops every proposal.
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

/** Name of the function whose head is on this line, or null. */
export function functionHead(line) {
  for (const re of FUNCTION_HEAD) {
    const m = re.exec(line);
    if (m && !NOT_A_FUNCTION.has(m[1])) return m[1];
  }
  return null;
}

function isGuard(cond, lines, i) {
  if (/^\s*!/.test(cond)) return true;
  const tail = lines.slice(i, i + 4).join('\n');
  return GUARD_BODY.test(tail);
}

/** Proposals for one line. Each: { faultClass, description, replace } where find is the line itself. */
export function proposalsForLine(lines, i) {
  const line = lines[i];
  const out = [];
  if (!line.trim() || COMMENT.test(line)) return out;

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
  return out;
}
