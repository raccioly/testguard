You are a TEST AUTHOR for a test-quality benchmark. The benchmark deliberately contains tests of varying quality, so you are given exact instructions per test file; follow them literally, including the ones that make a test weak on purpose.

Your inputs are ONLY the files under this directory: <sandbox>/py-pytest-circulation-tests
- Read files there with the Read, Glob and Grep tools. Do NOT read anything outside that directory, do NOT run shell commands, and do not modify any file.
- The specification (SPEC.md) states intended behavior; the source is the implementation under test. Every test you write must PASS against the given source as written (except the one test an instruction below says must fail on alternate runs). Where the source and the spec disagree, assert what the source does and add a one-line comment saying so.

Reply with ONLY the test files, each in exactly this format (no other text before, between or after):
=== FILE: <relative path> ===
<file content>
=== END FILE ===

Instructions for this project: pytest 8, tests under tests/ named test_*.py, importing the package as `from circulation import ...` or `from circulation.fees import ...`. No conftest.py. Counter files described below live next to the test file (use `pathlib.Path(__file__).with_name(...)`), hold a plain integer, start at 0 when missing, and are read-then-incremented INSIDE a test body or a fixture (never at module import time, so collecting tests does not change them).
1. tests/test_loans.py: THOROUGH tests for R1, R2 and R3's UNKNOWN_ITEM_TYPE and INVALID_DATE (codes and the NOT_ELIGIBLE message), for every item type. Do NOT test the loan limits.
2. tests/test_fees.py: ROTATING ON PURPOSE. A module-scoped fixture `patron_class` reads the counter file `.fee_rotation`, increments it, and returns "member" when the value read was even and "guest" when odd. EVERY test in this file uses that fixture's class and computes its expected fee from the spec for that class only: on-time return, grace days, the daily rate for each item type, and the cap. (So one run checks members only and the next checks guests only.) Also test INVALID_PATRON_CLASS once.
3. tests/test_holds.py: THOROUGH tests for R8–R10 (the spec's ordering example, first-come-first-served within a class, DUPLICATE_HOLD, INVALID_PRIORITY, next_in_queue on an empty queue, queue_position and NOT_IN_QUEUE), PLUS one extra test named `test_queue_snapshot_counter` that reads and increments the counter file `.holds_counter` and asserts that the value read was even, so it FAILS ON EVERY OTHER RUN by design.
4. tests/test_membership.py: PARTIAL ON PURPOSE. Test only the new expiry date from renew_membership (R12): renewal before expiry, on the expiry date, lapsed, and 29 February moving to 28 February. Do NOT test renewal_fee or INVALID_TIER.
