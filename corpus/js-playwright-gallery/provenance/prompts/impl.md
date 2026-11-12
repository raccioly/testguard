You are an IMPLEMENTER. Implement the specification in SPEC.md as a small library.
- Your only input is the file <sandbox>/js-playwright-gallery-impl/SPEC.md. Read it with the Read tool. Do NOT read any other file, do NOT run shell commands, and do not modify any file.
- Write SOURCE CODE ONLY. Do not write tests, examples, or documentation.
- Reply with ONLY the files, each in exactly this format (no other text before, between or after):
=== FILE: <relative path> ===
<file content>
=== END FILE ===
- Errors: use the spec's error names exactly (as the error's `name`) and its messages verbatim where given.
- Keep it compact and idiomatic: roughly 200-350 lines in total.

Tooling and layout (required):
- A static web page with browser ES modules, no build step, no third-party packages. Files: `index.html` and modules under `src/`: one module per "## " area (pure functions, exported), plus `src/app.js` that wires the DOM and is loaded by index.html with `<script type="module" src="./src/app.js">`. Modules import each other with relative paths including the `.js` extension.
- The sample data lives in `src/data.js` as an exported array of 8 cards with ids "p1".."p8", years spread between 1890 and 2020, at least 5 distinct tags, and at least one card with duplicate/uppercase tags so normalization is visible. app.js loads (validates and normalizes) these cards at startup.
- DOM contract the page must follow exactly: search input `id="search"` (filters on every input event); a container `id="tags"` holding one `<button>` per tag with attribute `data-tag="<tag>"` and `aria-pressed`; a `<select id="sort">` with options `value="title"` and `value="year"`; a grid container `id="grid"` with one element per visible card having class `card` and `data-id`, containing elements with classes `title`, `photographer`, `year`, one `tag` element per tag, and a `<button class="fav">` with `aria-pressed`; a status element `id="status"` for "Showing N of M photos"; an element `id="favorites"` for "Favorites: K"; an element `id="empty"` that shows "No photos match your filters." and is hidden (the `hidden` attribute) otherwise.
