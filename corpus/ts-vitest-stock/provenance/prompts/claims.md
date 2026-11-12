You are a CLAIM AUTHOR for a test-quality benchmark. A "claim" states a promise the code makes, tied to one numbered requirement of the specification; each claim carries "faults": exact text replacements in one source file that would break that promise.

Your inputs are ONLY the files under this directory: <sandbox>/ts-vitest-stock-claims
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

Instructions for this project (TypeScript, strict mode):
- Write 7 to 8 claims with 16 to 21 faults in total. Every "## " area of SPEC.md gets at least one claim.
- In each of the four areas, include at least one fault that makes an operation THROW an exception for ordinary valid input (e.g. dereferencing undefined, calling a missing method) and at least one fault that makes an operation return or store a WRONG VALUE without throwing.
- Include at least one claim tied to R13 whose faults change only what reportTotals returns (e.g. one of its sums).
- Exactly one fault (in any claim) has a "replace" that is NOT syntactically valid TypeScript, so the file cannot be parsed.
- Exactly one fault has a "replace" that is syntactically valid and still runs as JavaScript, but fails the strict TypeScript type check (for example assigning a string where a number is declared), AND changes observable behavior for the claim.
- Exactly one fault has a "find" that does NOT occur in the file at all: a plausible stale anchor, e.g. the line as it might have looked in an older version with a different variable name.
- Exactly one fault has a "find" that occurs EXACTLY TWICE in its file; give that fault the extra field "expectHits": 1.
- State the promise in each statement from the specification's point of view, not the code's.
