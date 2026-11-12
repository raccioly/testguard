# Floor Planning Toolkit Specification

This document describes two cooperating parts of a fictional floor-planning tool. The **geometry core** is standalone and knows nothing about floors or materials. The **planner** uses the geometry core and adds layout, lot-fit checking, material estimates, and summaries. All lengths are positive finite numbers unless stated otherwise.

## Geometry Core: Shapes and Measurement

**R1.** *(Geometry core)* The core provides a rectangle shape with a width and a height. Its area is width × height and its perimeter is 2 × (width + height). A rectangle 4 wide and 2.5 high has area 10 and perimeter 13.

**R2.** *(Geometry core)* The core provides an L-shaped room defined by an outer width, an outer height, a notch width, and a notch height. The notch is removed from the top-right corner. The area is (outer width × outer height) − (notch width × notch height). The perimeter equals that of the outer rectangle (the notch does not change it). An L-shape with outer 10 × 8 and notch 4 × 3 has area 68 and perimeter 36.

**R3.** *(Geometry core)* Shape creation rejects invalid input with an error named `InvalidDimension`. A dimension is invalid if it is zero, negative, NaN, or infinite. For an L-shape, a notch width greater than or equal to the outer width, or a notch height greater than or equal to the outer height, is also rejected with `InvalidDimension`.

## Geometry Core: Units and Overlap

**R4.** *(Geometry core)* An operation named convertLength takes a value and a source unit and target unit, each one of `m`, `cm`, `ft`, `in`. It converts using exactly 1 ft = 0.3048 m and 1 in = 0.0254 m, and rounds the result to 4 decimal places (half away from zero). Converting 10 `ft` to `m` gives 3.048; converting 100 `cm` to `in` gives 39.3701.

**R5.** *(Geometry core)* An operation named convertArea takes an area value and the same units, and converts by the square of the linear factor, rounded to 4 decimal places. Converting 1 square `m` to square `ft` gives 10.7639. An unrecognized unit name is rejected with the error `UnknownUnit`, whose message is `Unknown unit: <name>`.

**R6.** *(Geometry core)* An operation named overlaps takes two rectangles, each with a position (x, y of the lower-left corner) plus width and height, and returns true only if they share interior area. Rectangles that merely touch along an edge or corner do not overlap. Rectangle A at (0,0) sized 4×4 and B at (4,0) sized 2×2 returns false; B at (3,0) returns true.

## Planner: Layout and Lot Fit

**R7.** *(Planner)* An operation named placeRoom adds a rectangular room to a plan, with a unique name, a position, and a size. If the new room overlaps any room already in the plan (as defined by R6), it is rejected with the error `RoomOverlap`, whose message is `Room "<name>" overlaps "<existing name>"`, naming the first overlapping room in insertion order. A duplicate room name is rejected with `DuplicateRoom`.

**R8.** *(Planner)* An operation named fitsInLot takes a plan and a lot (a rectangle at the origin with a width and height). It returns true only if every room lies fully inside the lot, with touching the lot boundary allowed. A room at (0,0) sized 5×5 fits in a 5×5 lot. A room at (1,0) sized 5×5 does not. An empty plan fits any lot.

**R9.** *(Planner)* Lot fit takes an optional setback distance, default 0. When a setback of s is given, every room must lie at least s inside every lot edge. A negative setback is rejected with `InvalidDimension`.

## Planner: Material Estimate

**R10.** *(Planner)* An operation named estimateFlooring takes a room's floor area in square meters, a material type (`tile` or `carpet`), and returns the number of square meters to purchase. The waste factors differ by class: tile adds 10%, carpet adds 5%. The result is rounded up to the next whole 0.5 square meters. A 20 m² room of tile yields 22.0; a 20 m² room of carpet yields 21.0; a 10.2 m² room of tile yields 11.5 (11.22 rounded up).

**R11.** *(Planner)* Estimating with a material type other than `tile` or `carpet` is rejected with `UnknownMaterial`, whose message is `Unknown material: <name>`. A zero or negative area is rejected with `InvalidDimension`.

**R12.** *(Planner)* An estimate for an L-shaped room uses the area computed by the geometry core (R2), so an L-shape of area 68 m² in carpet yields 71.5 (71.4 rounded up).

## Planner: Summary

**R13.** *(Planner)* An operation named summarize takes a plan and returns the room count, the total floor area in square meters (rounded to 2 decimals), and the room names sorted alphabetically (case-insensitive). A plan with rooms "Den" (3×4) and "Attic" (2×2.5) yields count 2, total area 17, names ["Attic", "Den"].

**R14.** *(Planner)* The summary can be requested in a chosen unit system, `metric` or `imperial`. Imperial reports total area in square feet using R5, rounded to 2 decimals. Any other system name is rejected with `UnknownUnit`. An empty plan yields count 0, area 0, and an empty name list.
