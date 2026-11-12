You are a SPEC AUTHOR. Write a plain-language specification for a small software library. Rules:
- Do NOT read any files, run any commands, or use any tools. Work only from this message.
- Reply with ONLY the Markdown document, starting with a "# " title line. No preamble, no closing remarks.
- 9 to 12 numbered requirements, written "R1.", "R2.", ... at the start of a line, each concrete enough that a tester could write an exact expected value or error for it (state inputs, outputs, rounding, error conditions and their error names/messages).
- Use a neutral, fictional domain only: no real companies, people or products.
- Describe behavior, not code: do not prescribe file names, function signatures in a particular language, or test frameworks.
- Include at least one requirement with two clearly distinct input classes handled by different rules, and at least one requirement about rejecting invalid input with a named error.
- Keep the whole document under 850 words.

Domain: three cooperating parts of a fictional library-catalog tool, each a separately published part. "Core" defines catalog records (ISBN-13 validation with check digit, title normalization, author name parsing "Last, First"). "Search" uses Core to index records and answers queries (exact ISBN lookup, case-insensitive title prefix search, results sorted by title then year). "Report" uses Search and Core to produce summaries (counts per decade, a formatted citation line for a record). Group the requirements under "## Core", "## Search" and "## Report", and make clear which part each requirement belongs to.
