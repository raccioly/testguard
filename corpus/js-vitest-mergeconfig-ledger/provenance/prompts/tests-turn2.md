The coordinator sent a message while you were working:
Four of your tests fail against the given source, which breaks the rule that every test must pass. All four come from your `portions()` helper turning a 0 balance into -0 (`-b[name]`), which toEqual distinguishes from +0:

FAIL test/split.test.js > R2 equal split > orders names by byte order, so uppercase sorts before lowercase — expected { a: -0, B: 1, Z: 1 } to deeply equal { B: 1, Z: 1, a: +0 }
FAIL ... > gives zero to later names when the amount is smaller than the head count
FAIL ... > R3 shares split > breaks remainder ties toward the alphabetically earlier name
FAIL ... > R1 InvalidAmount > accepts the smallest valid amount

Fix only this, keeping every other instruction. Reply with ONLY the corrected test/split.test.js in the same === FILE === format. Same input restrictions as before: read only files in your sandbox, no shell commands.

Address this before completing your current task.
