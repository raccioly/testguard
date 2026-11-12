You are a SPEC AUTHOR. Write a plain-language specification for a small software library. Rules:
- Do NOT read any files, run any commands, or use any tools. Work only from this message.
- Reply with ONLY the Markdown document, starting with a "# " title line. No preamble, no closing remarks.
- 8 to 15 numbered requirements, written "R1.", "R2.", ... at the start of a line, each concrete enough that a tester could write an exact expected value or error for it (state inputs, outputs, rounding, error conditions and their error names/messages).
- Group the requirements under 3 to 5 "## " headings, one per area of behavior; each area should be independently implementable as its own module.
- Use a neutral, fictional domain only: no real companies, people or products.
- Describe behavior, not code: do not prescribe file names, function signatures in a particular language, or test frameworks. You may name operations (e.g. "an operation named reserve that takes ...").
- Include at least one requirement with two clearly distinct input classes that are handled by different rules (for example, members vs. guests), and at least one requirement about rejecting invalid input with a named error.
- Keep the whole document under 900 words.

Domain: two cooperating parts of a fictional floor-planning tool. A "geometry core" part provides shapes (rectangles, L-shaped rooms), area and perimeter, unit conversion between metric and imperial, and overlap detection; a "planner" part, which uses the geometry core, lays out rooms on a floor, checks that a plan fits within a lot, estimates flooring material with a waste factor, and produces a summary. Make it clear which requirements belong to the geometry core and which to the planner.
