const { exportRows } = require('../src/export');

// Imports the export module but MOCKS it, and never asserts on the mocked
// function: by the import rule alone a "defender" of EXPORT-002, in fact
// unable to detect any fault in what it replaced. Discovery must leave it out.
jest.mock('../src/export', () => ({ exportRows: jest.fn(() => []) }));

test('renders an empty export table', () => {
  const rows = exportRows([{ id: 1, content: 'secret' }]);
  expect(Array.isArray(rows)).toBe(true);
});
