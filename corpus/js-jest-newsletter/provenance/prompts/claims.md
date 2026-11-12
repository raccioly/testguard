You are a CLAIM AUTHOR for a test-quality benchmark. A "claim" states a promise the code makes, tied to one numbered requirement of the specification; each claim carries "faults": exact text replacements in one source file that would break that promise.

Your inputs are ONLY the files under this directory: <sandbox>/js-jest-newsletter-claims
- Read files there with the Read, Glob and Grep tools. Do NOT read anything outside that directory, do NOT run shell commands, and do not modify any file.
- There are no tests in the project yet; do not look for any.

Reply with ONLY one ```json fenced block containing an array of claims, no other text. Shape:
[
  { "id": "UPPER-KEBAB-ID", "requirement": "R3", "statement": "One sentence stating the promise.", "severity": "critical|high|medium|low",
    "faults": [
      { "id": "F1", "description": "What the fault does, one sentence.", "faultClass": "<class>", "file": "<path relative to the directory>",
        "find": "<exact text that occurs in the file>", "replace": "<replacement text>" }
    ] }
]
- faultClass is one of: guard-removed, condition-forced, statement-deleted, variable-swap, literal-changed, call-removed, return-altered, exception-swallowed, field-dropped, argument-swapped.
- "find" must be copied EXACTLY from the file (whitespace included; use \n inside the JSON string for a multi-line anchor) and must occur EXACTLY ONCE in that file, except where an instruction below says otherwise. Keep anchors short but unique. "replace" must differ from "find".
- Each fault must make the code violate its claim's statement for at least one input the specification allows. Give each claim 2 to 3 faults of different faultClasses.
- Number fault ids F1, F2, F3 within each claim.

Instructions for this project (CommonJS JavaScript):
- Write 7 to 9 claims with 16 to 21 faults in total. Every "## " area of SPEC.md gets at least one claim.
- One claim tied to R8 must include a fault that makes countWords NEVER RETURN for ordinary input (an infinite loop, e.g. inserting `while (true) {}` or forcing a loop condition to stay true).
- At least one claim tied to R9 with two faults in the reading-time code that return wrong values without throwing.
- In the slug area (R5–R7), include one fault that makes slugify THROW for an ordinary title (e.g. calling a method that does not exist on a string) and one that returns a wrong slug without throwing.
- At least one claim tied to R14 (footer) with 2 faults, and at least one claim tied to one of R11–R13 (scheduling) with 2 faults.
- Exactly one fault (in any claim) has a "replace" that is NOT syntactically valid JavaScript, so the file cannot be loaded.
- Exactly one fault has a "find" that does NOT occur in the file at all: a plausible stale anchor, e.g. the line as it might have looked in an older version with a different variable name.
- Exactly one fault has a "find" that occurs EXACTLY TWICE in its file; give that fault the extra field "expectHits": 1.
- State the promise in each statement from the specification's point of view, not the code's.
