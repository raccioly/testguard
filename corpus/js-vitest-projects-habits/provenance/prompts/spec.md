You are a SPEC AUTHOR. Write a plain-language specification for a small software library. Rules:
- Do NOT read any files, run any commands, or use any tools. Work only from this message.
- Reply with ONLY the Markdown document, starting with a "# " title line. No preamble, no closing remarks.
- 7 to 9 numbered requirements, written "R1.", "R2.", ... at the start of a line, each concrete enough that a tester could write an exact expected value or error for it (state inputs, outputs, rounding, error conditions and their error names/messages).
- Group the requirements under 2 to 3 "## " headings, one per area of behavior.
- Use a neutral, fictional domain only: no real companies, people or products.
- Describe behavior, not code: do not prescribe file names, function signatures in a particular language, or test frameworks.
- Include at least one requirement about rejecting invalid input with a named error.
- Keep the whole document under 600 words.

Domain: a small habit-tracker library for a fictional wellness app: recording daily check-ins, computing the current streak and the longest streak (with a one-day grace rule for "freeze" days), and weekly completion percentages rounded to whole percent.
