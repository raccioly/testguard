// Export of audit rows. No test file imports this module — on purpose.
// EXPORT-001 declares a defender that does not exist, which is the `nocover` case.

/** Return rows for export with the content field removed. */
export function exportRows(rows) {
  return rows.map(({ content, ...rest }) => rest);
}
