// Export of audit rows. No test file imports this module — on purpose (the `nocover` case).
function exportRows(rows) {
  return rows.map(({ content, ...rest }) => rest);
}
module.exports = { exportRows };
