import { it, expect, vi } from 'vitest';
import { exportRows } from '../src/export.mjs';

// This test IMPORTS the export module but MOCKS it, and never asserts on the
// mocked function. By the import rule alone it would be a "defender" of
// EXPORT-002; it cannot detect any fault in what it replaced. Discovery must
// leave it out (nocover), and the evidence must say why (mocked-never-asserted).
vi.mock('../src/export.mjs', () => ({ exportRows: vi.fn(() => []) }));

it('renders an empty export table', () => {
  const rows = exportRows([{ id: 1, content: 'secret' }]);
  expect(Array.isArray(rows)).toBe(true);
});
