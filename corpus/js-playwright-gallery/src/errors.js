export function makeError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}
