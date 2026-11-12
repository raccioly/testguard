# Regional Parcel Rate Library (Fictional Courier "Brindle Post")

All weights are in grams, all lengths in millimeters, all money in whole cents. Rounding rules are stated per requirement.

## Parcel Validation

R1. A parcel has length, width, height (integers, mm) and actual weight (integer, grams). Each dimension must be between 10 and 1200 inclusive, and weight between 1 and 30000 inclusive. Any value outside its range, or a non-integer, is rejected with error `InvalidParcel`, with a message naming the first offending field in the order length, width, height, weight (e.g. `InvalidParcel: height must be between 10 and 1200`).

R2. Dimensional weight in grams is length × width × height ÷ 5000, rounded up to the next whole gram. Example: 300 × 200 × 100 gives 6,000,000 ÷ 5000 = 1200 g. Example: 101 × 101 × 101 gives 1,030,301 ÷ 5000 = 206.06, so 207 g.

R3. Billable weight is the greater of actual weight and dimensional weight, rounded up to the next full 500 g step. Examples: actual 1200 g and dimensional 800 g gives 1500 g; actual 1000 g and dimensional 1000 g gives 1000 g; actual 1001 g gives 1500 g.

## Rate Calculation

R4. Zones are integers 1 to 4. Any other zone value is rejected with error `UnknownZone`, message `UnknownZone: <value>`. Any service level other than `standard` or `express` (case-sensitive) is rejected with error `UnknownService`, message `UnknownService: <value>`. Zone is checked before service.

R5. The standard base rate is 450 cents for the first 500 g step plus a per-extra-step charge determined by zone: 60 cents (zone 1), 90 (zone 2), 140 (zone 3), 210 (zone 4). Example: 1500 g in zone 3 is 3 steps, so 450 + 2 × 140 = 730 cents.

R6. Express uses the standard base rate for the same weight and zone, multiplied by 1.75 and rounded half up to the nearest cent, then increased by a flat 300 cents. Example: standard 730 gives 1277.5, rounded to 1278, plus 300 equals 1578 cents. Billable weight above 20000 g is rejected for express only, with error `ExpressWeightLimit` and message `ExpressWeightLimit: 20000`; standard accepts up to 30000 g.

## Surcharges

R7. Remote-area surcharge applies when the destination postal code is on the remote list. A postal code is exactly five digits. A code that is not five digits is rejected with `InvalidPostalCode`, message `InvalidPostalCode: <value>`. Codes beginning with `99` or in the inclusive range 80000 to 80499 are remote; all others are not. A remote destination adds 275 cents on standard and 400 cents on express.

R8. Oversize surcharge has two classes decided by the longest dimension. Longest side from 600 to 999 mm inclusive adds 500 cents ("large"). Longest side 1000 mm or more adds 1500 cents ("giant"). Longest side under 600 mm adds nothing. The giant class is not charged on top of the large class; only one oversize charge ever applies. Oversize surcharges are the same for both service levels.

R9. The total quote is the base rate (R5 or R6) plus the remote surcharge plus the oversize surcharge, returned as an itemized breakdown (base, remote, oversize, total) in cents. Example: standard, zone 2, 1000 g billable, remote code 99120, longest side 650: 450 + 90 = 540, remote 275, oversize 500, total 1315 cents.

## Label Formatting

R10. A tracking number is the prefix `BP`, a nine-digit zero-padded sequence number, and one check digit, e.g. `BP0000000427` followed by its check digit. The check digit is the sum of the nine digits, with each digit in an even position (counting from 1 at the left) tripled, taken modulo 10. Example: sequence 000000427 has digits weighted 0,0,0,0,0,0,4,2×3,7... positions 8 is tripled: 4 at position 7 stays 4, 2 at position 8 becomes 6, 7 at position 9 stays 7, sum 17, check digit 7, giving `BP0000004277`. A sequence number below 0 or above 999999999 is rejected with `InvalidSequence`, message `InvalidSequence: <value>`.

R11. Verifying a tracking number returns true only if it has the `BP` prefix, exactly nine digits and one check digit, and the check digit matches R10. Any other string, including lowercase `bp`, returns false and never raises an error.

R12. The printable address block is: recipient name uppercased, then street line, then `<CITY> <POSTAL>` with the city uppercased, each on its own line, joined by a single newline with no trailing newline. Each line is truncated to 30 characters, and a truncated line ends with `~` as its 30th character. A missing or empty recipient, street, city or postal code is rejected with `InvalidAddress`, message `InvalidAddress: <field> is required`.
