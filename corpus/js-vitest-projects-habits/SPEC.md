# Habit Tracker Library Specification

A small library for a fictional wellness app, "Calmly". It records daily check-ins for one habit and reports streaks and weekly completion. All dates are calendar dates in the form YYYY-MM-DD, with no time zone or time of day. Weeks run Monday through Sunday.

## Recording check-ins

R1. Recording a check-in for a valid date stores it for that day. Recording the same date twice is allowed and has no extra effect: the habit still counts as checked in once on that day, and no error is raised.

R2. A date that is not a real calendar date (for example "2025-02-30", "2025-13-01", or "2025-1-5") is rejected with the error `InvalidDateError` and the message "Invalid date: <input>", where <input> is the text supplied. Nothing is stored.

R3. A check-in dated later than the current date supplied by the caller is rejected with `FutureDateError` and the message "Check-in date is in the future: <date>". A check-in dated today is accepted.

R4. A user may mark a day as a "freeze" day. A freeze day is not a check-in and does not count as completed for weekly percentages. It only affects streaks, as described below. Marking a date that already has a check-in as a freeze day is rejected with `ConflictError` and the message "Date already has a check-in: <date>". The same validation rules from R2 and R3 apply to freeze dates.

## Streaks

R5. The current streak is the number of consecutive calendar days, ending on the current date or on the day before it, that each have a check-in. If today has no check-in but yesterday does, the streak is still alive and counts back from yesterday. If neither today nor yesterday has a check-in, the current streak is 0. With no data at all, it is 0.

R6. Freeze rule. A freeze day bridges a gap without adding to the count: a freeze day sitting between check-ins keeps the streak unbroken, but contributes 0 to its length. At most one freeze day may bridge any single gap. Two or more consecutive days without check-ins, whether frozen or not, break the streak. Example: check-ins on 2025-03-01, 2025-03-02 and 2025-03-04, with 2025-03-03 frozen, give a streak of 3. If 2025-03-03 is not frozen, the run ending on 03-04 has length 1, and the longest streak is 2.

R7. The longest streak is the greatest streak length found anywhere in the recorded history, using the same counting and freeze rules as R5 and R6. It is always greater than or equal to the current streak. With no check-ins it is 0.

## Weekly completion

R8. The weekly completion percentage for a week is the number of days in that week with a check-in, divided by 7, multiplied by 100, rounded to the nearest whole percent, with halves rounding up. The result is an integer from 0 to 100. Examples: 3 check-ins give 43 (42.857 rounds up), 1 gives 14 (14.286), 4 gives 57 (57.143), and 7 gives 100. A week with no check-ins gives 0. The week is identified by any date inside it, so asking about a Wednesday reports on the Monday-to-Sunday week that contains it.

R9. For a week that includes days after the current date, the percentage is still computed over 7 days, so future days count as not completed. For example, on a Wednesday with check-ins on Monday, Tuesday and Wednesday, the percentage is 43. An invalid date passed to the weekly query is rejected with `InvalidDateError`, as in R2.
