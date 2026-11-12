/**
 * Every way testguard refuses to start is named. The kind is what an adapter
 * branches on under `--json` (an `error` document, `error.schema.json`); the
 * message stays for humans on stderr. A throw site without a kind is a build
 * failure (`test/precondition-kinds.test.mjs` scans every site), so a new
 * refusal cannot be added unnamed.
 */
export const PRECONDITION_KINDS = Object.freeze([
  'budget-exhausted',      // --command-budget ran out and no partial result was asked for
  'claim-unknown',         // --claim names an id the claims file does not declare
  'claims-file-invalid',   // the claims file at a ref is not readable JSON
  'defender-ambiguous',    // two configured runners both list the same test file
  'defender-excluded',     // a defendedBy file the configured runners do not collect
  'defender-misrouted',    // a test file under the wrong runner
  'defender-outside-universe', // a defender no resolved runner's configured test universe contains
  'dirty-tree',            // uncommitted changes in files a verdict would depend on
  'discovery-failed',      // the runner could not list its tests
  'fault-unknown',         // admit --fault names a fault the claim does not have
  'install-changed',       // the user's node_modules changed during the run (#279): its verdicts are not reported
  'file-missing',          // a named file does not exist
  'init-settings',         // a hook settings file init would edit is unusable
  'module-shadowed',       // Python imported a different copy of the faulted module
  'no-base',               // --changed auto --when-no-base fail found no base to compare against
  'no-commits',            // the repository has no commit to tie a verdict to
  'no-fix-commits',        // replay found no fix commit in the range
  'path-outside-project',  // a named path escapes the project, repository or scratch tree
  'ref-unresolved',        // a git ref or range does not resolve
  'runner-unresolvable',   // the test runner cannot be found in the tree
  'scratch-dir',           // --scratch-dir / TESTGUARD_SCRATCH_DIR is unusable
  'typecheck-red-baseline', // the unmodified tree does not type-check, so no fault can be judged
  'typecheck-timeout',     // the baseline type check outran --budget
  'typecheck-unavailable', // --typecheck cannot run (no tsconfig, no compiler, bad command)
  'workspace-link-outside-tree', // a node_modules link names repository source the scratch tree does not contain
]);

/** Everything a `--json` refusal can say: the preconditions, the other exit-2 classes, usage (exit 3) and a defect of ours. */
export const ERROR_KINDS = Object.freeze([...PRECONDITION_KINDS, 'claims-file', 'git', 'spec-document', 'refused', 'usage', 'internal']);

/** A refusal to start: the run cannot be made safely, so nothing is measured. The CLI reports it as exit 2. */
export class PreconditionError extends Error {
  constructor(message, kind) {
    if (!PRECONDITION_KINDS.includes(kind)) throw new TypeError(`PreconditionError needs a kind from PRECONDITION_KINDS (got ${JSON.stringify(kind)}): ${message}`);
    super(message);
    this.kind = kind;
  }
}

/**
 * A request that is wrong whatever the repository holds: a bad value, or flags
 * that cannot be combined. Exit 3, the documented usage code. A condition that
 * depends on the tree is a PreconditionError (exit 2) instead.
 */
export class UsageError extends Error { kind = 'usage'; }

const WIRE_EXIT = { usage: 3 };

/**
 * The `--json` document for a refusal: `{kind, message, exitCode}` under
 * `error`. `error` may be an Error of a class the CLI models, or an already
 * classified `{kind, message, exitCode}` (a refusal a command reported by
 * returning an exit code). Anything else is a defect in testguard: `internal`.
 */
export function errorDocument(error, { version }) {
  const kind = ERROR_KINDS.includes(error?.kind) && typeof error?.message === 'string' ? error.kind : 'internal';
  const exitCode = error?.exitCode ?? WIRE_EXIT[kind] ?? 2;
  return { schemaVersion: 1, tool: { name: 'testguard', version }, error: { kind, message: String(error?.message || '(no message)').slice(0, 4000), exitCode } };
}
