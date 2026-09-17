// Redaction engine for the known-answer fixture.
//
// Every claim in ../testguard.claims.json is about this file. The code is
// deliberately small and deliberately has one real blind spot in its tests:
// see test/redact.test.mjs and the REDACT-001/F1 expectation.

/** Compile a rule's pattern; an invalid pattern yields null and is skipped. */
function safeRegex(pattern) {
  try {
    return new RegExp(pattern, 'g');
  } catch {
    return null;
  }
}

/** Find a rule by id. */
export function findRule(rules, id) {
  for (const rule of rules) {
    if (rule.id === id) return rule;
  }
  return null;
}

/** Compile all rules. An invalid pattern is skipped; it never aborts the scan. */
export function compileRules(rules) {
  const compiled = [];
  for (const rule of rules) {
    const re = safeRegex(rule.pattern);
    if (re === null) continue;
    compiled.push({ ...rule, re });
  }
  return compiled;
}

/** Replace every match of every rule with asterisks of equal length. */
export function mask(input, rules) {
  let out = input;
  for (const rule of compileRules(rules)) {
    out = out.replace(rule.re, (m) => '*'.repeat(m.length));
  }
  return out;
}

/**
 * Redact a message and write an audit row when anything was masked.
 * @claim REDACT-003 Fails closed: a missing scope is an error, never an unscoped scan.
 * The audit row must never carry the original input.
 */
export async function redact(input, rules, ctx, store) {
  if (!ctx || !ctx.scope) {
    throw new Error('redact: scope is required');
  }
  const redacted = mask(input, rules);
  if (redacted !== input) {
    await store.writeAudit({
      action: 'MASK',
      scope: ctx.scope,
      ruleCount: rules.length,
      content: redacted,
    });
  }
  return redacted;
}
