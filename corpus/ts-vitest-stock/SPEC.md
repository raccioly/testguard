# Warehouse Stock Reservation Library

A library that tracks stock for items identified by a SKU. Each item has an on-hand quantity (physical units in the warehouse) and reserved quantities (units promised to open reservations). Available quantity is always on-hand minus total reserved. All quantities are whole numbers.

## Stock Reservations

R1. An operation named reserve takes a SKU, a positive whole quantity, a customer type ("member" or "guest") and a reservation time. It succeeds only if the quantity is less than or equal to the item's available quantity. On success it returns a reservation with a unique id, and available quantity drops by the reserved amount; on-hand is unchanged.

R2. Reserve rejects invalid input with a named error. A quantity that is zero, negative or not a whole number fails with `InvalidQuantity` and the message "quantity must be a positive integer". An unknown SKU fails with `UnknownSku`. A request larger than the available quantity fails with `InsufficientStock`, and no stock state changes.

R3. An operation named release takes a reservation id and returns its quantity to available stock. Releasing an id that does not exist fails with `UnknownReservation`. Releasing a reservation that was already released or already expired fails with `ReservationNotActive`.

R4. Reservation lifetime depends on customer type. A member reservation expires 48 hours after its reservation time; a guest reservation expires 2 hours after it. A reservation is active until the exact expiry instant and expired from that instant on (at exactly 2 hours, a guest reservation is already expired).

R5. An operation named sweep takes a current time, marks every active reservation whose expiry is at or before that time as expired, returns their quantity to available stock, and returns the number of reservations it expired. Calling sweep twice with the same time returns 0 the second time.

## Stock Adjustments

R6. An operation named receive takes a SKU and a positive whole quantity and adds it to on-hand, registering the SKU if it is new. An invalid quantity fails with `InvalidQuantity`. A SKU must be 3 to 12 characters of uppercase letters, digits or hyphens, otherwise the operation fails with `InvalidSku`.

R7. An operation named writeOff takes a SKU and a positive whole quantity and reduces on-hand. It may not reduce on-hand below the currently reserved total; such a request fails with `InsufficientStock` and changes nothing.

## Pricing and Discounts

R8. An operation named priceOrder takes a list of reservation ids and a price table mapping SKUs to unit prices in whole cents, and returns a subtotal, a discount and a total, all in whole cents. The subtotal is the sum of quantity times unit price across the reservations. A SKU missing from the price table fails with `MissingPrice`. Any reservation in the list that is not active fails with `ReservationNotActive`.

R9. Discounts depend on customer type. A member order receives 10% off the subtotal. A guest order receives no percentage discount. An order mixing member and guest reservations fails with `MixedCustomerTypes`.

R10. A bulk rule applies on top of R9 to both customer types: if the total quantity across the order is 100 or more units, an extra 5% of the subtotal is discounted. The discount is the sum of all applicable percentages applied to the original subtotal, not compounded. Percentage discounts are rounded half up to a whole cent, and total equals subtotal minus discount. For example, a member order with subtotal 12345 cents and 100 units has a discount of 15% of 12345, which is 1851.75, rounded to 1852, and a total of 10493.

## Reporting

R11. An operation named stockReport returns, for each known SKU, an entry with onHand, reserved, available and a status, sorted ascending by SKU. Status is "out" when available is 0, "low" when available is between 1 and 9 inclusive, and "ok" when available is 10 or more. Only active reservations count toward reserved.

R12. stockReport accepts an optional filter by status. A filter value other than "out", "low" or "ok" fails with `InvalidFilter` and the message "status must be one of out, low, ok". With a valid filter only matching entries are returned, still sorted by SKU.

R13. An operation named reportTotals returns the number of SKUs, the sum of onHand, the sum of reserved and the sum of available across all SKUs. With no SKUs registered, all four values are 0.
