You are an IMPLEMENTER. Implement the specification in SPEC.md as a small library.
- Your only input is the file <sandbox>/js-vitest-projects-habits-impl/SPEC.md. Read it with the Read tool. Do NOT read any other file, do NOT run shell commands, and do not modify any file.
- Write SOURCE CODE ONLY. Do not write tests, examples, or documentation.
- Reply with ONLY the files, each in exactly this format (no other text before, between or after):
=== FILE: <relative path> ===
<file content>
=== END FILE ===
- Errors: use the spec's error names exactly (as the error class's `name`) and its messages verbatim where given.
- Keep it compact and idiomatic: roughly 150-250 lines in total.

Tooling and layout (required):
- Plain JavaScript ES modules (`.js`, "type": "module"), Node 20+, no third-party packages. Modules under `src/`: `src/errors.js`, `src/dates.js` (calendar-date parsing/validation helpers), `src/tracker.js` (a `createTracker()` object with `checkIn(date, today)`, `freeze(date, today)`, `currentStreak(today)`, `longestStreak()`, `weeklyCompletion(date)`), relative imports with `.js`. Dates are "YYYY-MM-DD" strings; compute with UTC-based Date arithmetic.
