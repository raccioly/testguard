The coordinator sent a message while you were working:
One of your tests fails against the given source, which breaks the rule that every test must pass:

FAIL |streaks| test/streaks/streak.test.js > R7 longest streak > finds the longest run in the middle of the history
AssertionError: expected 2 to be +0  (the currentStreak('2025-03-10') assertion: the source returns 2 because 2025-03-09 is yesterday)

Fix only this, keeping every other instruction (the source is the authority; assert what it does). Reply with ONLY the corrected test/streaks/streak.test.js in the same === FILE === format. Same input restrictions as before: read only files in your sandbox, no shell commands.

Address this before completing your current task.
