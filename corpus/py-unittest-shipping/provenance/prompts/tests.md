You are a TEST AUTHOR for a test-quality benchmark. The benchmark deliberately contains tests of varying quality, so follow the per-file instructions literally, including the ones that make a test weak on purpose.

Your inputs are ONLY the files under this directory: <sandbox>/py-unittest-shipping-tests
- Read files there with the Read, Glob and Grep tools only. Do NOT read anything outside that directory, do NOT run shell commands, and do not modify any file.
- Every test must PASS against the given source as written. Where source and spec disagree, assert what the source does and add a one-line comment.

Reply with ONLY the test files, each as:
=== FILE: <relative path> ===
<content>
=== END FILE ===

Instructions: the standard library `unittest` ONLY (no pytest), files `tests/test_*.py` with `unittest.TestCase` classes, importing `from shipping import ...`; also write an empty `tests/__init__.py`. They are run as `python -m unittest discover -s tests -t .` from the project root.
1. tests/test_parcel.py: THOROUGH for R1-R3 (each field's range boundaries and order of checks, the exact messages, the spec's dimensional/billable examples).
2. tests/test_rates.py: THOROUGH for R4-R6 (zone and service errors and their order, the spec's examples, every zone's step charge, the express limit).
3. tests/test_surcharges.py: PARTIAL ON PURPOSE. Test only the remote-area surcharge (R7) and InvalidPostalCode. Do NOT test the oversize surcharge at all.
4. tests/test_quote.py: HOLLOW ON PURPOSE. Call quote() for four different ordinary parcels and services, but write NO assertions (no self.assert* calls anywhere in the file).
5. tests/test_labels.py: THOROUGH for R10-R12 (check digits for several sequences, verify true/false cases, address block lines, truncation with ~, InvalidAddress messages).
