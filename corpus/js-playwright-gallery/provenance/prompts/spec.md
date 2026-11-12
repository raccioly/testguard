You are a SPEC AUTHOR. Write a plain-language specification for a small software library. Rules:
- Do NOT read any files, run any commands, or use any tools. Work only from this message.
- Reply with ONLY the Markdown document, starting with a "# " title line. No preamble, no closing remarks.
- 8 to 12 numbered requirements, written "R1.", "R2.", ... at the start of a line, each concrete enough that a tester could write an exact expected value or error for it (state inputs, outputs, rounding, error conditions and their error names/messages).
- Group the requirements under 3 to 4 "## " headings, one per area of behavior; each area should be independently implementable as its own module.
- Use a neutral, fictional domain only: no real companies, people or products.
- Describe behavior, not code: do not prescribe file names, function signatures in a particular language, or test frameworks.
- Include at least one requirement with two clearly distinct input classes handled by different rules, and at least one requirement about rejecting invalid input with a named error.
- Keep the whole document under 800 words.

Domain: a single web page for a fictional community photo exhibit. The page shows a grid of photo cards (title, photographer, year, tags), a text search box and tag filter buttons that narrow the grid, a sort control (by year or title), and a "favorites" toggle per card with a counter of favorites. Requirements must be observable in the rendered page (visible text, counts, order, attributes such as aria-pressed) as well as in the behavior of the underlying functions.
