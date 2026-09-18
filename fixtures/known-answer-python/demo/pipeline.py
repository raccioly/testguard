"""A non-test module that imports the redaction engine: it gives demo/redact.py a blast radius above zero."""

from demo.redact import redact


def run_batch(messages, patterns, ctx, store):
    return [redact(m, patterns, ctx, store) for m in messages]
