You are a CLAIM AUTHOR for a test-quality benchmark. A "claim" states a promise the code makes, tied to one numbered requirement of the specification; each claim carries "faults": exact text replacements in one source file that would break that promise.

Your inputs are ONLY the files under this directory: <sandbox>/js-playwright-gallery-claims
- Read files there with the Read, Glob and Grep tools only. Do NOT read anything outside that directory, do NOT run shell commands, and do not modify any file. There are no tests; do not look for any.

Reply with ONLY one ```json fenced block containing an array of claims, no other text:
[ { "id": "UPPER-KEBAB-ID", "requirement": "R3", "statement": "One sentence.", "severity": "critical|high|medium|low",
    "faults": [ { "id": "F1", "description": "...", "faultClass": "<class>", "file": "<path relative to the directory>", "find": "<exact text>", "replace": "<replacement>" } ] } ]
- faultClass is one of: guard-removed, condition-forced, statement-deleted, variable-swap, literal-changed, call-removed, return-altered, exception-swallowed, field-dropped, argument-swapped.
- "find" must be copied EXACTLY from the file and occur EXACTLY ONCE in it unless told otherwise; "replace" must differ. 2 to 3 faults per claim, of different faultClasses; ids F1, F2, F3 within each claim. Each fault must break its claim's statement for some input the specification allows.

Instructions for this project (a static page, browser ES modules under src/):
- Write 6 to 7 claims with 13 to 17 faults in total, covering R1, R2, R4, R7, R8 and R10 at least.
- One claim tied to R6 or R7 (favorites) must include a fault that makes toggling a favorite THROW for a valid card and one that changes the favorites count or aria-pressed without throwing.
- Exactly one fault has a "replace" that is NOT valid JavaScript.
- State each promise from the specification's point of view.
