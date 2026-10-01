# Native Node known-answer fixture

This neutral project uses only Node test/assert APIs. The intended guarantees
are recorded in its claims document. The audit defender deliberately asserts
only the row kind, so it misses exposed content. The unused module has no
importing defender. The two counter tests deliberately model an unstable
baseline and a mixed response to the fault. The unused module declared against
the policy defender tests the negative control: that test never imports it.

Do not run these intentionally faulty/flaky cases as a normal project suite.
Before accepting expected.json, apply each exact recipe manually in a scratch
copy, run its real declared defenders with the Node test CLI, inspect baseline,
fault and restored results, and record the interpretation independently of
TestGuard. A timeout, syntax error and incomplete confirmation are unproven.
The fixture requires no installed package or network access.
