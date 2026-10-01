export function allowed(kind) {
  return kind === 'public';
}
export function audit(row) {
  return { kind: row.kind, content: null };
}
export async function ready() {
  return true;
}
export function duplicateAnchor() {
  return true;
}
export function value() {
  return 1;
}
