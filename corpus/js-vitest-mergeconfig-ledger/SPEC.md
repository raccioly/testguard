# Shared Apartment Expense Ledger

A small library that records shared expenses for a fictional apartment, computes each roommate's net balance, and proposes settle-up payments. All money is integer cents. Roommate names are non-empty strings, compared case-sensitively.

## Recording Expenses

R1. An expense has a payer, a positive whole-cent amount, and a list of participants. The payer need not be a participant. If the amount is zero, negative, or not a whole number of cents, recording fails with error `InvalidAmount`.

R2. If a split is "equal", the amount is divided among the participants. Each gets the floor of amount divided by participant count. The leftover cents (amount mod count) are given one each, as extra cents, to the participants in ascending alphabetical (byte-order) name order. Example: 100 cents among Ana, Bo, Cy gives Ana 34, Bo 33, Cy 33; 100 among Bo, Ana gives Ana 50, Bo 50.

R3. If a split is "shares", each participant has a positive whole-number share weight. A participant's portion is floor(amount × weight / total weight), and any leftover cents are given one each in descending order of fractional remainder. Ties go to the alphabetically earlier name. Example: 100 cents with weights Ana 1, Bo 2 gives Ana 33, Bo 67.

R4. An expense whose participants list is empty, contains a duplicate name, or whose shares include a weight that is zero, negative or non-integer, fails with error `InvalidSplit`. A split type other than "equal" or "shares" fails with `UnknownSplitType`.

## Balances

R5. A roommate's net balance is the total they paid minus the total of their portions across all expenses. A positive balance means they are owed money; a negative balance means they owe. Roommates who appear in no expense are absent from the result. Balances across all roommates always sum to exactly 0. If the payer is also a participant, their own portion is still subtracted from what they paid.

R6. Balances are computed from the recorded expenses in any order and give the same result. A ledger with no expenses returns an empty balance result without error.

## Settling Up

R7. Settle-up produces a list of payments, each with a payer, a recipient, and a positive whole-cent amount. Applying all payments leaves every balance at exactly 0. The list uses the minimum possible number of payments. A ledger where all balances are 0 produces an empty list.

R8. Among equally minimal solutions, the result is deterministic. Repeatedly match the largest debtor (ties by alphabetical name) with the largest creditor (ties by alphabetical name), and pay the smaller of the two absolute amounts. Example: balances Ana +500, Bo -300, Cy -200 yield Bo pays Ana 300, then Cy pays Ana 200. Payments are returned in the order they are produced.
