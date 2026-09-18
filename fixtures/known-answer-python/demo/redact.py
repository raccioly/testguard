"""A tiny redaction engine. Every claim about it is in the fixture README."""

import re


def compile_rules(patterns):
    """A pattern that will not compile is skipped; it never aborts the scan."""
    rules = []
    for pattern in patterns:
        try:
            rules.append(re.compile(pattern))
        except re.error:
            continue
    return rules


def find_rule(rules, rule_id):
    for rule in rules:
        if rule.pattern == rule_id:
            return rule
    return None


def scope_of(ctx):
    if not ctx:
        return None
    return ctx.get("scope")


def mask(text, rules):
    out = text
    for rule in rules:
        out = rule.sub(lambda m: "*" * len(m.group(0)), out)
    return out


def redact(text, patterns, ctx, store):
    # @claim REDACT-003: a missing scope fails closed; no unscoped scan ever runs.
    if not ctx or not ctx.get("scope"):
        raise ValueError("scope is required")
    rules = compile_rules(patterns)
    redacted = mask(text, rules)
    if redacted != text:
        store.write_audit({
            "action": "MASK",
            "scope": ctx["scope"],
            "rule_count": len(rules),
            "content": redacted,
        })
    return redacted
