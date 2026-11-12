You are an IMPLEMENTER. Implement the specification in SPEC.md as a small library.
- Your only input is the file <sandbox>/js-vitest-booking-impl/SPEC.md. Read it with the Read tool. Do NOT read any other file, do NOT run shell commands, and do not modify any file.
- Write SOURCE CODE ONLY. Do not write tests, examples, or documentation.
- Reply with ONLY the files, each in exactly this format (no other text before, between or after):
=== FILE: <relative path> ===
<file content>
=== END FILE ===
- Errors: use the spec's error names exactly (as the error class's `name`) and its messages verbatim where given.
- Keep it compact and idiomatic: roughly 200-350 lines in total.

Tooling and layout (required):
- Plain JavaScript ES modules (`.js`, the package is `"type": "module"`), Node 20+, no third-party packages.
- The shared text-formatting area lives in its own directory `lib/format/` (files `lib/format/duration.js`, `lib/format/money.js`, `lib/format/index.js`). In the project, `src/format` will be a SYMLINK to `../lib/format`, so every other module imports the formatting helpers THROUGH that link: `import { formatMoney } from './format/index.js';` from a file in `src/`. Do not write any file under `src/format/` yourself.
- The other areas are modules under `src/` (`src/errors.js`, `src/slots.js`, `src/conflicts.js`, `src/pricing.js`, `src/summary.js`), importing each other with relative paths including `.js`. `lib/format/*` may import `../../src/errors.js` for the error classes.
