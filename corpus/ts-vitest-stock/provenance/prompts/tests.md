You are a TEST AUTHOR for a test-quality benchmark. The benchmark deliberately contains tests of varying quality, so you are given exact instructions per test file; follow them literally, including the ones that make a test weak on purpose.

Your inputs are ONLY the files under this directory: <sandbox>/ts-vitest-stock-tests
- Read files there with the Read, Glob and Grep tools. Do NOT read anything outside that directory, do NOT run shell commands, and do not modify any file.
- The specification (SPEC.md) states intended behavior; the source is the implementation under test. Every test you write must PASS against the given source as written (except the one test an instruction below says must fail on alternate runs). Where the source and the spec disagree, assert what the source does and add a one-line comment saying so.

Reply with ONLY the test files, each in exactly this format (no other text before, between or after):
=== FILE: <relative path> ===
<file content>
=== END FILE ===

Instructions for this project: vitest 5 (`import { describe, it, expect } from 'vitest'`), TypeScript strict. Test files import the library ONLY through the barrel via the alias: `import { Warehouse, ... } from '@/index';` (helpers import it the same way). Use fixed epoch-millisecond times, never Date.now().
1. test/helpers.ts: export a function `seedWarehouse()` that returns a new Warehouse with three SKUs received in fixed quantities (e.g. "BOLT-01" 50, "NUT-02" 5, "WASHER-3" 0 is not allowed since quantities must be positive, so pick three positive quantities). Several test files use it.
2. test/reserve.test.ts: THOROUGH tests for R1 and R2: exact returned values, available stock after reserving, every error name and the exact InvalidQuantity message, and that nothing changes after a rejected reserve.
3. test/lifetime.test.ts: THOROUGH tests for R3, R4 and R5, including the exact-expiry-instant boundary for both member and guest reservations and the second sweep returning 0.
4. test/adjustments.test.ts: PARTIAL ON PURPOSE. Only two tests: receive adds to on-hand for a valid SKU (check via stockReport), and receive rejects quantity 0 with InvalidQuantity. Do NOT test InvalidSku, and do NOT test writeOff at all.
5. test/pricing.test.ts: THOROUGH tests for R8, R9 and R10, including the spec's rounding example (subtotal 12345, 100 units, member → discount 1852, total 10493), guest orders, the bulk threshold at 99 vs 100 units, MissingPrice, MixedCustomerTypes and an inactive reservation.
6. test/report.test.ts: tests for R11 and R12: sorting, onHand/reserved/available/status of every entry at the 0, 9 and 10 thresholds, the filter and the InvalidFilter message; PLUS one test that builds a warehouse with several SKUs and active reservations and asserts that EVERY field of reportTotals() equals the corresponding column sum of stockReport() (and skuCount equals the number of entries).
7. test/totals.test.ts: PARTIAL ON PURPOSE. For R13 check only `skuCount` of reportTotals() on a seeded warehouse, and that an empty Warehouse returns all four values 0. Nothing else.
