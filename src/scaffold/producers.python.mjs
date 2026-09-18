/**
 * Mechanical fault producers for Python. Deterministic, line-oriented, no AST,
 * no LLM — the same contract as `producers.mjs`, expressed in the syntax the
 * file is actually written in.
 *
 * The fault classes are the ones the spec already closes over; none is new.
 * The two JSX shapes (`element-removed`, `handler-dropped`) have no Python
 * meaning and are absent rather than faked.
 *
 * One deliberate difference from JavaScript: a statement is removed by
 * replacing it with `pass`, not by deleting the line. A block whose only
 * statement is deleted is an IndentationError in Python, and a fault that
 * cannot compile is a `fault-invalid` verdict — a wasted probe run that says
 * nothing about the tests. `pass` removes the behaviour and always parses.
 */

const COMMENT = /^\s*#/;

// `if <cond>:` and `elif <cond>:`, with an optional same-line body.
const IF_LINE = /^(\s*)(el)?if\s+(.+?)\s*:\s*(\S.*)?$/;
const GUARD_BODY = /\braise\b|\breturn\b|\bcontinue\b|\bbreak\b|\babort\b|\bsys\.exit\b|\bFalse\b|\bNone\b|\bHTTPException\b|\b4\d\d\b/;
const RETURN_CHECK = /^(\s*)return\s+(.+?)\s*$/;
const CHECK_EXPR = /(==|!=|\bin\b|\bis\b|\bnot\b|\band\b|\bor\b|\.startswith\(|\.endswith\(|\.match\(|\.search\(|\.fullmatch\(|isinstance\(|\.issubset\(|>=|<=|>|<)/;
const CHECK_CALL = /^\s*(?:await\s+)?(?:[\w.]+\.)?(verify|validate|assert|check|require|ensure|authoriz|authentic|rate_limit|throttle|enforce|guard|sanitiz|escape|audit)\w*\s*\(.*\)\s*$/i;
const MUTATION = /^\s*(?!(?:return|if|elif|else|for|while|with|try|except|finally|raise|assert|import|from|def|class|yield|pass|global|nonlocal)\b)[\w.\[\]'"]+\s*(=|\+=|-=|\|=|&=)\s*(?!=)\S.*$/;

const FLAG_TRUE = /\b(verify|secure|httponly|check_hostname|require_tls|validate_certs|strict|signed|use_tls|ssl)\s*=\s*True\b/i;
const SAME_SITE = /\b(samesite)\s*=\s*(['"])(strict|lax)\2/i;
const COST_NUM = /\b(\w*(?:cost|rounds|iterations|work_factor)\w*)\s*=\s*(\d+)\b/i;
const WINDOW_NUM = /\b(\w*(?:ttl|expir|tolerance|window|max_age|maxage|timeout|limit|attempts|length|min_length|clock_skew|skew|leeway)\w*)\s*=\s*(\d+)\b/i;

const DEF_LINE = /^(\s*)(?:async\s+)?def\s+([\w]+)\s*\(/;
// A definition is not a call site and not a statement: `def f(x)` must never
// be read as `f(x)` with a swappable argument.
const DEFINITION = /^\s*(?:async\s+)?(?:def|class)\b/;

/**
 * Does this line leave a bracket open, or continue onto the next?
 *
 * `COLOURS = {` is an assignment by every regex here, but replacing it with
 * `pass` orphans the lines below it and the file stops parsing. Python has no
 * statement terminator to lean on the way the JavaScript producers lean on
 * `;`, so the balance is counted instead. A fault that cannot compile is a
 * `fault-invalid` verdict: a probe run spent saying nothing about the tests.
 */
function isIncomplete(line) {
  const code = line.replace(/#.*$/, '');
  if (/\\\s*$/.test(code)) return true;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
  }
  return depth > 0;
}

/** The function a `def` line opens, or null. */
export function functionHead(line) {
  const m = DEF_LINE.exec(line);
  return m ? m[2] : null;
}

/** The indentation of a line, in characters. Blank lines have none. */
export const indentOf = (line) => (line.trim() ? line.length - line.trimStart().length : null);

/** Parameter names of a `def` line, without `self`/`cls`, defaults or annotations. */
export function functionParams(line) {
  const m = /^\s*(?:async\s+)?def\s+\w+\s*\(([^)]*)\)/.exec(line);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((p) => p.trim().replace(/^[*]+/, '').split(/[:=]/)[0].trim())
    .filter((p) => /^\w+$/.test(p) && p !== 'self' && p !== 'cls');
}

export const isComment = (line) => COMMENT.test(line);

/** Does this `if` guard something — does its body reject, raise or return? */
function isGuard(sameLineBody, lines, i) {
  if (sameLineBody) return GUARD_BODY.test(sameLineBody);
  const next = lines[i + 1] ?? '';
  return GUARD_BODY.test(next);
}

// ── field-dropped ─────────────────────────────────────────────────────────
// A dict literal counts as a payload when its opening line says so: it is
// returned, assigned to a payload-ish name, or passed to a persistence or
// transport call. A TypedDict or a class body is never a payload — dropping a
// key there changes a type, not a behaviour.
const PAYLOAD_OPENER = /(\breturn\s*\{\s*$|\b(?:body|payload|input|item|params|data|record|row|attrs|attributes|values|fields|patch|update|updates|changes|doc|document|entity|dto|request|response|options|args|props|config|settings|message|event|entry|audit|claims|headers|context)\w*\s*=\s*\{\s*$|\.(?:save|update|put|patch|post|send|write|insert|upsert|create|set|publish|emit|dispatch|persist|store|log|audit|record|track|notify|write_audit)\w*\s*\(\s*(?:[^,{]*,\s*)*\{\s*$)/i;
const DICT_ENTRY = /^(\s*)(['"])([\w.-]+)\2\s*:\s*(.+?),\s*$/;
const ALLOWLIST_OPENER = /\b\w*(?:fields|keys|allowed|writable|columns|attributes|props|allowlist|whitelist|editable|mutable|updatable|permitted|required|scopes|roles)\w*\s*=\s*[\[({]\s*$/i;
const STRING_ENTRY = /^\s*(['"])[^'"]+\1\s*,\s*$/;

function fieldDropProposals(lines, i) {
  const line = lines[i];
  const entry = DICT_ENTRY.exec(line);
  const isStringEntry = STRING_ENTRY.test(line);
  if (!entry && !isStringEntry) return [];
  const lineIndent = indentOf(line);
  for (let j = i - 1; j >= 0 && j >= i - 40; j--) {
    const opener = lines[j];
    if (!opener.trim() || COMMENT.test(opener)) continue;
    const openerIndent = indentOf(opener);
    // The first line above that is less indented opens the literal this entry
    // belongs to. Anything at the same indentation is a sibling entry.
    if (openerIndent !== null && lineIndent !== null && openerIndent < lineIndent) {
      if (entry && PAYLOAD_OPENER.test(opener)) {
        return [{ faultClass: 'field-dropped', description: `Field dropped: \`${entry[3]}\` no longer appears in the object built at line ${j + 1}.`, replace: '' }];
      }
      if (isStringEntry && ALLOWLIST_OPENER.test(opener)) {
        return [{ faultClass: 'field-dropped', description: `Entry removed from the list at line ${j + 1}: \`${line.trim().replace(/,$/, '')}\`.`, replace: '' }];
      }
      return [];
    }
  }
  return [];
}

// ── argument-swapped ──────────────────────────────────────────────────────
// A call is kept and one parameter-derived argument is swapped for a trivial
// value, so the call still happens and still proves nothing.
const CALL_WITH_ARGS = /\b([\w.]+)\s*\(([^()]*)\)/g;

function argumentSwapProposals(lines, i, params) {
  const line = lines[i];
  if (!params.size || COMMENT.test(line)) return [];
  const out = [];
  for (const m of line.matchAll(CALL_WITH_ARGS)) {
    const args = m[2];
    if (!args.trim()) continue;
    const parts = args.split(',').map((a) => a.trim());
    for (let n = 0; n < parts.length; n++) {
      const arg = parts[n];
      const named = /^(\w+)\s*=\s*(\w+)$/.exec(arg);
      const bare = /^\w+$/.test(arg) ? arg : null;
      const value = named ? named[2] : bare;
      if (!value || !params.has(value)) continue;
      const trivial = named ? `${named[1]}=None` : 'None';
      const swapped = [...parts.slice(0, n), trivial, ...parts.slice(n + 1)].join(', ');
      out.push({
        faultClass: 'argument-swapped',
        description: `Call kept, argument neutralised: \`${m[1]}(…)\` receives ${trivial} in place of \`${arg}\`.`,
        replace: line.replace(m[0], `${m[1]}(${swapped})`),
      });
      break; // one proposal per call is enough for a human to judge
    }
  }
  return out;
}

/**
 * Every fault this line supports. `ctx.params` is the enclosing function's
 * parameter names; `ctx.fieldDrops` disables payload shapes in files where a
 * dict literal is data rather than something the product sends.
 */
export function proposalsForLine(lines, i, ctx = {}) {
  const out = [];
  const line = lines[i];
  if (!line.trim() || COMMENT.test(line) || DEFINITION.test(line)) return out;
  const params = ctx.params ?? new Set();
  const indent = ' '.repeat(indentOf(line) ?? 0);

  const ifm = IF_LINE.exec(line);
  if (ifm && isGuard(ifm[4], lines, i)) {
    if (ifm[4]) {
      // `if not allowed: raise …` — the whole guard is this one line.
      out.push({ faultClass: 'statement-deleted', description: `Guard removed: \`${line.trim()}\` no longer runs.`, replace: `${indent}pass` });
    } else {
      out.push({ faultClass: 'condition-forced', description: `Guard never triggers: \`${ifm[2] ?? ''}if ${ifm[3].trim()}\` becomes \`${ifm[2] ?? ''}if False\`.`, replace: `${ifm[1]}${ifm[2] ?? ''}if False:` });
    }
    return out; // an `if` line is not also a mutation, a return or a call
  }

  const rm = RETURN_CHECK.exec(line);
  if (rm && CHECK_EXPR.test(rm[2]) && !/^(await|yield)\b/.test(rm[2])) {
    out.push({ faultClass: 'return-altered', description: `Check always passes: \`return ${rm[2]}\` becomes \`return True\`.`, replace: `${rm[1]}return True` });
  }

  const complete = !isIncomplete(line);
  if (complete && CHECK_CALL.test(line)) {
    out.push({ faultClass: 'call-removed', description: `Check call removed: \`${line.trim()}\` no longer runs.`, replace: `${indent}pass` });
  } else if (complete && MUTATION.test(line)) {
    out.push({ faultClass: 'statement-deleted', description: `State change removed: \`${line.trim()}\` no longer runs.`, replace: `${indent}pass` });
  }

  let m;
  if ((m = FLAG_TRUE.exec(line))) {
    out.push({ faultClass: 'literal-changed', description: `Security flag flipped: \`${m[1]}=True\` becomes \`${m[1]}=False\`.`, replace: line.replace(m[0], `${m[1]}=False`) });
  }
  if ((m = SAME_SITE.exec(line))) {
    out.push({ faultClass: 'literal-changed', description: `samesite weakened: \`${m[3]}\` becomes \`none\`.`, replace: line.replace(m[0], `${m[1]}=${m[2]}none${m[2]}`) });
  }
  if ((m = COST_NUM.exec(line))) {
    // 0 and 1 are already the weakest a work factor can be.
    if (Number(m[2]) > 1) out.push({ faultClass: 'literal-changed', description: `Work factor collapsed: \`${m[1]}\` ${m[2]} becomes 1.`, replace: line.replace(m[0], `${m[1]}=1`) });
  } else if ((m = WINDOW_NUM.exec(line))) {
    // ×1000 leaves a zero window at zero, and a zero window is the one worth
    // widening: `max_age=0` is a session cookie, `expires_in=0` is already
    // expired. Fall back to the factor itself so the fault is a real widening.
    const widened = Number(m[2]) * 1000 || 1000;
    out.push({ faultClass: 'literal-changed', description: `Window widened: \`${m[1]}\` ${m[2]} becomes ${widened}.`, replace: line.replace(m[0], `${m[1]}=${widened}`) });
  }

  if (ctx.fieldDrops !== false) out.push(...fieldDropProposals(lines, i));
  out.push(...argumentSwapProposals(lines, i, params));
  return out;
}
