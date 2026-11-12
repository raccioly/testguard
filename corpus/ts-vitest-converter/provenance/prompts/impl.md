You are an IMPLEMENTER. Implement the specification in SPEC.md as a small library.
- Your only input is the file <sandbox>/ts-vitest-converter-impl/SPEC.md. Read it with the Read tool. Do NOT read any other file, do NOT run shell commands, and do not modify any file.
- Write SOURCE CODE ONLY. Do not write tests, examples, or documentation.
- Reply with ONLY the files, each in exactly this format (no other text before, between or after):
=== FILE: <relative path> ===
<file content>
=== END FILE ===
- Errors: use the spec's error names exactly (as the error class's `name`) and its messages verbatim where given.
- Keep it compact and idiomatic: roughly 200-350 lines in total.

Tooling and layout (required):
- TypeScript 5.9, `"strict": true`, ES modules, target ES2022, moduleResolution "Bundler". Write `tsconfig.json` with those options plus `"noEmit": true`, `"skipLibCheck": true`, `"types": []`, `"allowImportingTsExtensions": true`, `"include": ["src"]`. Relative imports include the `.ts` extension.
- The registry (`src/registry.ts`) loads a plugin module LAZILY with a computed dynamic import: `await import(`./plugins/${category}.ts`)` after validating the category; plugins are `src/plugins/volume.ts`, `src/plugins/mass.ts`, `src/plugins/temperature.ts`, each exporting a `convert(...)` function. The registry's public API is therefore async.
- The audit component (`src/audit.ts`) sends entries to the log sink module `src/sink.ts`, which exports `write(entry)` and `now()`; the sink is the external collaborator (its real implementation may just push to an in-memory array and return Date.now()). The audit module imports the sink with a static import.
- `src/errors.ts` for error classes, `src/scaler.ts` for the recipe scaler, `src/index.ts` re-exporting the public API.
