You are an IMPLEMENTER. Implement the specification in SPEC.md as a small library.
- Your only input is the file <sandbox>/py-unittest-shipping-impl/SPEC.md. Read it with the Read tool. Do NOT read any other file, do NOT run shell commands, and do not modify any file.
- Write SOURCE CODE ONLY. Do not write tests, examples, or documentation.
- Reply with ONLY the files, each in exactly this format (no other text before, between or after):
=== FILE: <relative path> ===
<file content>
=== END FILE ===
- Errors: use the spec's error names exactly as exception class names (each a subclass of a common `ShippingError(Exception)`), with the spec's messages verbatim as the exception message where given.
- Keep it compact and idiomatic: roughly 200-350 lines in total.

Tooling and layout (required):
- Python 3.10+, standard library only. A package `shipping/` at the project root: `shipping/__init__.py` re-exporting the public functions, one module per "## " area of the spec, and `shipping/errors.py`. Modules import each other with absolute imports (`from shipping.errors import ...`).
- Functions in snake_case (e.g. `validate_parcel`, `dimensional_weight`, `billable_weight`, `quote`, `tracking_number`, `verify_tracking`, `address_block`). Money and weights are ints.
