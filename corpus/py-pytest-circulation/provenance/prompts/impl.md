You are an IMPLEMENTER. Implement the specification below as a small library. Rules:
- Do NOT read any files, run any commands, or use any tools. Work only from this message.
- Write SOURCE CODE ONLY. Do not write tests, examples, or documentation.
- Reply with ONLY the files, each in exactly this format (no other text before, between or after):
=== FILE: <relative path> ===
<file content>
=== END FILE ===

Tooling and layout (required):
- Python 3.10+, standard library only. A package named `circulation` at the project root: circulation/__init__.py plus one module per "## " area of the spec and a shared circulation/errors.py (4 to 6 modules in total). Modules import each other with absolute package imports, e.g. `from circulation.errors import CirculationError`.
- circulation/__init__.py re-exports the public operations.
- Errors: one exception class `CirculationError(Exception)` carrying a `code` attribute equal to the spec's error name (e.g. "NOT_ELIGIBLE") and the spec's message where given. Raise it as `CirculationError(code, message)`.
- Dates are `datetime.date` objects; a date given as an ISO string "YYYY-MM-DD" must also be accepted and validated (an impossible date such as 2025-02-30 raises INVALID_DATE).
- State (loans, holds) lives in plain classes you instantiate (e.g. a `Circulation` or `HoldQueue` object), not in module globals; keep stateless operations as functions.
- Function and method names use snake_case (create_loan, compute_late_fee, place_hold, next_in_queue, queue_position, renew_membership).
- Keep it compact and idiomatic; the whole package should be roughly 200–400 lines.

SPECIFICATION:

# Community Lending Library Circulation Package

A small package that manages loans, late fees, hold queues, and membership for a neighborhood lending library. All dates are whole calendar days. All money is in whole cents, so every fee result is an integer number of cents.

## Loans and Due Dates

R1. An operation named createLoan takes a patron id, an item id, an item type, and a checkout date. The due date is the checkout date plus a loan period set by item type: "book" 21 days, "tool" 7 days, "game" 14 days, "dvd" 7 days. Example: a "tool" checked out on 2025-03-01 is due 2025-03-08.

R2. Items of type "tool" or "game" can be loaned to members only. Items of type "book" or "dvd" can be loaned to members or guests. A guest requesting a "tool" or "game" is rejected with the error NOT_ELIGIBLE and the message "guests cannot borrow this item type".

R3. An item type outside the four listed in R1 is rejected with the error UNKNOWN_ITEM_TYPE. A checkout date that is not a real calendar date (for example 2025-02-30) is rejected with the error INVALID_DATE. A patron who already has 5 active loans (members) or 2 active loans (guests) is rejected with the error LOAN_LIMIT_REACHED.

## Late Fees

R4. An operation named computeLateFee takes a due date, a return date, an item type, and a patron class ("member" or "guest"). If the return date is on or before the due date, the fee is 0.

R5. Grace days are subtracted from the number of days late before charging. Members get 3 grace days and guests get 0. Billable days = max(0, days late − grace days). Example: a member returning 5 days late has 2 billable days; a guest returning 5 days late has 5 billable days.

R6. The daily rate depends on patron class and item type. For members the rate is 10 cents per day for "book" and "dvd", and 25 cents per day for "tool" and "game". For guests every rate is doubled. Fee before cap = billable days × daily rate. Example: a guest returning a "game" 4 days late owes 4 × 50 = 200 cents.

R7. The fee is capped at 1500 cents for members and 1000 cents for guests, for every item type. Example: a member returning a "tool" 100 days late owes 1500 cents, and a guest returning a "book" 100 days late owes 1000 cents. A patron class other than "member" or "guest" is rejected with the error INVALID_PATRON_CLASS.

## Hold Queues

R8. An operation named placeHold takes an item id, a patron id, and a priority class: "staff", "member", or "guest". Each item has one queue. Position in the queue is ordered by priority class first (staff, then member, then guest), and within the same class by the order in which holds were placed (first come, first served). Example: holds placed in the order guest A, member B, staff C, member D produce the queue C, B, D, A.

R9. A patron may have at most one hold per item. A second hold on the same item by the same patron is rejected with the error DUPLICATE_HOLD. A priority class outside the three listed is rejected with the error INVALID_PRIORITY.

R10. An operation named nextInQueue takes an item id and returns the patron id at the front of the queue and removes it from the queue. If the queue is empty it returns no patron and does not raise an error. An operation named queuePosition takes an item id and a patron id and returns the 1-based position, or the error NOT_IN_QUEUE if the patron has no hold on that item.

## Membership Tiers and Renewal

R11. Membership has three tiers: "basic", "standard", and "plus". Annual fees are 1000, 2500, and 4000 cents respectively. An operation named renewMembership takes a tier, an expiry date, and a renewal date, and returns a new expiry date.

R12. If the renewal date is on or before the current expiry date, the new expiry is the current expiry plus one year (same month and day; 29 February moves to 28 February in a non-leap year). If the renewal date is after the expiry date (a lapsed membership), the new expiry is the renewal date plus one year.

R13. Renewing within 30 days before expiry (renewal date between expiry minus 30 days and expiry, inclusive) earns an early-renewal discount of 10% off the annual fee, rounded down to a whole cent. Example: "standard" renewed 10 days before expiry costs 2250 cents. All other renewals pay the full fee. A tier outside the three listed is rejected with the error INVALID_TIER.
