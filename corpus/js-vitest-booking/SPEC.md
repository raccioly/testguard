# Meeting-Room Booking Helper for Brightnook Commons

This library supports a fictional co-working space, Brightnook Commons, with one meeting room. All times are on a 24-hour clock within a single day, and all money is whole US cents.

## Time-slot parsing and validation

R1. A slot string has the form "HH:MM-HH:MM" (exactly two digits, a colon, two digits, a hyphen, then the same again). Parsing "09:30-11:00" yields start 570 and end 660, in minutes after midnight. Surrounding whitespace is not allowed.

R2. Hours must be 00-23 and minutes 00-59. Input "24:00-25:00" or "09:60-10:00" is rejected with the error `InvalidTimeError`.

R3. A slot must start before it ends and last at least 15 minutes. Slots must also start and end on a quarter hour (minutes 00, 15, 30, 45). "10:00-10:00" and "11:00-10:00" are rejected with `InvalidRangeError`. "10:00-10:10" is rejected with `InvalidRangeError`. A string not matching the format in R1 (e.g. "9:30-11:00", "09:30 - 11:00", "") is rejected with `MalformedSlotError`. The format check happens first, then R2, then R3.

## Conflict detection

R4. Two slots conflict if they overlap for at least one minute. Slots that merely touch do not conflict: "09:00-10:00" and "10:00-11:00" have no conflict. "09:00-10:00" and "09:45-10:30" conflict.

R5. Given a list of existing bookings (each a slot string) and a proposed slot string, the check returns the list of existing bookings that conflict, in their original input order. An empty list means the proposed slot is free. If any string in either input is invalid, the corresponding error from R1-R3 is raised and no result is returned.

R6. Given a list of slot strings, return the free gaps between 08:00 and 20:00 as slot strings in ascending order, merging overlapping or touching bookings first. Bookings "09:00-10:00" and "10:00-11:30" yield gaps "08:00-09:00" and "11:30-20:00". A booking that extends outside 08:00-20:00 is accepted and clipped to that window. With no bookings the result is ["08:00-20:00"].

## Pricing

R7. Rates per hour depend on two input classes. Members pay 2000 cents per hour off-peak and 3000 cents per hour peak. Drop-in visitors pay 4000 cents per hour off-peak and 6000 cents per hour peak. Peak hours are 10:00 up to but not including 16:00. All other minutes are off-peak. An unrecognized customer type (anything other than "member" or "dropin") is rejected with `UnknownCustomerError`.

R8. The price of a slot is the sum over each of its minutes of that minute's hourly rate divided by 60, rounded half up to a whole cent once at the end, not per minute. Member "09:30-10:30" costs 30 min off-peak (1000 cents) plus 30 min peak (1500 cents), for 2500 cents. Drop-in "15:30-16:30" costs 3000 + 2000 = 5000 cents.

R9. A member booking of 4 hours or more in total (end minus start) receives a 10 percent discount on the total from R8, rounded half up to a whole cent. Drop-in visitors never receive this discount. Member "08:00-12:00" is 2 h off-peak (4000) plus 2 h peak (6000) = 10000, discounted to 9000 cents. Member "08:00-11:45" lasts 3 h 45 m and gets no discount.

## Text formatting (shared)

R10. Duration formatting takes whole minutes and returns "Xh Ym", omitting a zero part: 90 gives "1h 30m", 120 gives "2h", 45 gives "45m", 0 gives "0m". A negative or non-integer input is rejected with `InvalidAmountError`.

R11. Money formatting takes whole cents and returns a dollar sign, the dollars with thousands separators, a period, and exactly two digits of cents: 1250 gives "$12.50", 5 gives "$0.05", 0 gives "$0.00", 123456 gives "$1,234.56". A negative or non-integer input is rejected with `InvalidAmountError`.

R12. A slot summary combines the other areas into a single line in the form "09:30-11:00 (1h 30m) $30.00" using the duration from R10 and the member price from R8-R9 formatted by R11, for a given customer type. An invalid slot or customer type raises the corresponding error from R1-R3 or R7.
