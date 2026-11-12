You are a TEST AUTHOR for a test-quality benchmark. The benchmark deliberately contains tests of varying quality, so you are given exact instructions per test file; follow them literally, including the ones that make a test weak on purpose.

Your inputs are ONLY the files under this directory: <sandbox>/node-test-floorplan-tests
- Read files there with the Read, Glob and Grep tools. Do NOT read anything outside that directory, do NOT run shell commands, and do not modify any file.
- The specification (SPEC.md) states intended behavior; the source is the implementation under test. Every test you write must PASS against the given source as written (except the one test an instruction below says must fail on alternate runs). Where the source and the spec disagree, assert what the source does and add a one-line comment saying so.

Reply with ONLY the test files, each in exactly this format (no other text before, between or after):
=== FILE: <relative path> ===
<file content>
=== END FILE ===

Instructions for this project: Node's built-in test runner only (`import { test, describe } from 'node:test'; import assert from 'node:assert/strict';`), ES modules, files named *.test.js, run with `node --test` from the workspace root. Geometry tests import their package by relative path (`../src/index.js`); planner tests import the planner by relative path (`../src/index.js`) and the geometry core ONLY by its package name (`import { LShape } from '@floorplan/geometry';`).
1. packages/geometry/test/shapes.test.js: THOROUGH tests for R1–R3: area and perimeter of the spec's examples, every invalid-dimension case (zero, negative, NaN, Infinity) and both notch rules, checking the error name.
2. packages/geometry/test/units.test.js: THOROUGH tests for R4–R6: the spec's conversion examples, a round trip, UnknownUnit name and exact message, and overlaps for overlap, edge-touching and corner-touching rectangles.
3. packages/planner/test/layout.test.js: THOROUGH for R7 and R8 (RoomOverlap name and exact message naming the first overlapping room, DuplicateRoom, rooms inside/outside/touching the lot, empty plan). PARTIAL ON PURPOSE for R9: only call fitsInLot without a setback; never pass a setback.
4. packages/planner/test/estimate.test.js: THOROUGH tests for R10–R12: the spec's tile/carpet examples, UnknownMaterial name and message, InvalidDimension for zero and negative area, and the R12 example computing the area with `new LShape(...)` from '@floorplan/geometry' (outer 10 × 8, notch 4 × 3) and estimating carpet for it.
5. packages/planner/test/summary.test.js: HOLLOW ON PURPOSE. Build a few plans and call summarize on them in both 'metric' and 'imperial', but write NO assertions at all: no assert calls anywhere in the file.
