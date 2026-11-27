// The structural half of the runner adapter contract (spec/RUNNER-ADAPTER.md).
// It reads an adapter module's exports and reports every place the module does
// not satisfy the contract. It starts no process and touches no file: whether an
// adapter runs a real project correctly is the adapter's own tests' business.
// Pure, so a second implementation of the contract can run the same checks.

const NAME = /^[a-z][a-z0-9-]*$/;
const EXTENSION = /^\.[a-z0-9]+(?:\.[a-z0-9]+)*$/;
const isFn = (v) => typeof v === 'function';
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);

/** The exports the contract names, with whether each is required. Exported so the document and the check cannot drift. */
export const ADAPTER_EXPORTS = Object.freeze({
  name: { required: true, kind: 'string' },
  check: { required: true, kind: 'function' },
  run: { required: true, kind: 'function' },
  tests: { required: 'unless discoverTests is present', kind: 'function' },
  discoverTests: { required: 'unless tests is present', kind: 'function' },
  testGlobs: { required: false, kind: 'string[]' },
  owns: { required: false, kind: 'function' },
  fatalEdit: { required: false, kind: 'function' },
  parseReport: { required: false, kind: 'function' },
  sharedExternalState: { required: false, kind: 'boolean' },
  extensions: { required: false, kind: 'string[]' },
});

/**
 * Violations of the contract by `adapter`, as `{ path, message }` (`path` is the
 * export). An empty array means the module conforms.
 */
export function checkRunnerAdapter(adapter) {
  const errors = [];
  const bad = (path, message) => errors.push({ path, message });
  if (adapter === null || typeof adapter !== 'object') return [{ path: '/', message: 'an adapter is a module namespace or an object' }];

  if (typeof adapter.name !== 'string' || !NAME.test(adapter.name)) bad('name', 'name is required: a lowercase identifier (letters, digits, hyphens) that the evidence records as the runner');
  if (!isFn(adapter.check)) bad('check', 'check({ projectDir, ... }) is required and must be a function returning { ok, version?, source?, engine?, message? }');
  if (!isFn(adapter.run)) bad('run', 'run({ projectDir, files, budgetMs, ... }) is required and must be a function returning the run result');
  if (!isFn(adapter.tests) && !isFn(adapter.discoverTests)) bad('tests', 'an adapter must name its test universe: tests(projectDir) or discoverTests({ projectDir, version })');
  for (const key of ['tests', 'discoverTests', 'owns', 'fatalEdit', 'parseReport']) {
    if (adapter[key] !== undefined && !isFn(adapter[key])) bad(key, `${key} must be a function when present`);
  }
  if (adapter.testGlobs !== undefined && !isStringArray(adapter.testGlobs)) bad('testGlobs', 'testGlobs must be an array of non-empty glob strings when present');
  if (adapter.sharedExternalState !== undefined && typeof adapter.sharedExternalState !== 'boolean') bad('sharedExternalState', 'sharedExternalState must be a boolean when present; only true has an effect');
  if (adapter.owns !== undefined && !isFn(adapter.tests)) bad('owns', 'an adapter that owns files must list them: owns needs tests(projectDir)');
  if (adapter.extensions !== undefined) {
    if (!isStringArray(adapter.extensions) || adapter.extensions.length === 0) bad('extensions', 'extensions must be a non-empty array of strings when present');
    else {
      for (const ext of adapter.extensions) if (!EXTENSION.test(ext)) bad('extensions', `extension ${JSON.stringify(ext)} must start with a dot and be lowercase (".java", ".cls")`);
      if (new Set(adapter.extensions).size !== adapter.extensions.length) bad('extensions', 'extensions must not repeat');
    }
  }
  if (isFn(adapter.fatalEdit)) {
    let content;
    try { content = adapter.fatalEdit(); } catch (error) { bad('fatalEdit', `fatalEdit() threw: ${error.message}`); }
    if (content !== undefined && (typeof content !== 'string' || content.length === 0)) bad('fatalEdit', 'fatalEdit() must return the non-empty text that replaces a file so that it cannot be parsed');
  }
  return errors;
}
