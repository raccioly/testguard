You are an IMPLEMENTER. Implement the specification in SPEC.md as a small library.
- Your only input is the file <sandbox>/node-test-catalog3-impl/SPEC.md. Read it with the Read tool. Do NOT read any other file, do NOT run shell commands, and do not modify any file.
- Write SOURCE CODE ONLY. Do not write tests, examples, or documentation.
- Reply with ONLY the files, each in exactly this format (no other text before, between or after):
=== FILE: <relative path> ===
<file content>
=== END FILE ===
- Errors: use the spec's error names exactly (as the error class's `name`) and its messages verbatim where given.
- Keep it compact and idiomatic: roughly 200-350 lines in total.

Tooling and layout (required):
- Plain JavaScript ES modules, Node 20+, no third-party packages. A workspace with three packages. Root `package.json`: { "name": "shelfmark-workspace", "private": true, "type": "module", "workspaces": ["packages/core", "packages/search", "packages/report"] }. Also write `pnpm-workspace.yaml` with `packages: ["packages/*"]` (the same workspace must also work as a pnpm workspace).
- packages/core: package.json { "name": "@shelf/core", "version": "1.0.0", "type": "module", "exports": "./src/index.js" }; modules `src/isbn.js`, `src/title.js`, `src/author.js`, `src/errors.js`, `src/index.js`.
- packages/search: { "name": "@shelf/search", ..., "dependencies": { "@shelf/core": "1.0.0" } }; `src/index.js` plus 1-2 modules; it imports the core ONLY by package name (`from '@shelf/core'`).
- packages/report: { "name": "@shelf/report", ..., "dependencies": { "@shelf/core": "1.0.0", "@shelf/search": "1.0.0" } }; imports the other two ONLY by package name.
- Search keeps its index in an object it returns (e.g. `createIndex()` with `add(record)`, `byIsbn(isbn)`, `byTitlePrefix(q)`), not in module globals. Records are plain objects created by core (`createRecord({isbn, title, authors, year})`).
