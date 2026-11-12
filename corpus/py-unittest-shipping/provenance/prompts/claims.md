You are a CLAIM AUTHOR for a test-quality benchmark. A "claim" states a promise the code makes, tied to one numbered requirement of the specification; each claim carries "faults": exact text replacements in one source file that would break that promise.

Your inputs are ONLY the files under this directory: <sandbox>/py-unittest-shipping-claims
- Read files there with the Read, Glob and Grep tools only. Do NOT read anything outside that directory, do NOT run shell commands, and do not modify any file. There are no tests; do not look for any.

Reply with ONLY one ```json fenced block containing an array of claims, no other text:
[ { "id": "UPPER-KEBAB-ID", "requirement": "R3", "statement": "One sentence.", "severity": "critical|high|medium|low",
    "faults": [ { "id": "F1", "description": "...", "faultClass": "<class>", "file": "<path relative to the directory>", "find": "<exact text>", "replace": "<replacement>" } ] } ]
- faultClass is one of: guard-removed, condition-forced, statement-deleted, variable-swap, literal-changed, call-removed, return-altered, exception-swallowed, field-dropped, argument-swapped.
- "find" must be copied EXACTLY from the file and occur EXACTLY ONCE in it unless told otherwise; "replace" must differ. 2 to 3 faults per claim, of different faultClasses; ids F1, F2, F3 within each claim. Each fault must break its claim's statement for some input the specification allows. A removed Python statement is replaced by `pass`, never by an empty string.

Instructions for this project (a Python package):
- Write 6 to 7 claims with 13 to 17 faults in total, covering R2, R5, R6, R7, R8, R9 and R10 at least.
- The claim tied to R9 (the itemized quote) must include one fault that makes quote() RAISE for an ordinary parcel and one that returns a wrong total without raising.
- The claim tied to R8 (oversize) must have 2 faults.
- Exactly one fault has a "replace" that is NOT valid Python.
- State each promise from the specification's point of view.
