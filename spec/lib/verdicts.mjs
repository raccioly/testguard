/**
 * The verdict vocabulary, scoped by method.
 *
 * WHY THIS IS NOT ONE FLAT SET. `killed` means "we broke the code and a test
 * caught it" — detection power, which is the question fault injection asks. A
 * tool that reads code or scans a surface asks a different question: is this
 * true *now*. Neither answer translates into the other's words, and forcing one
 * to borrow the other's would make every document say something false about
 * what it measured, in a format whose entire premise is not doing that.
 *
 * WHY NOT A GROWING UNION EITHER. Appending `holds` and `violated` to the same
 * flat enum works until tool five, at which point there are fifteen verdicts
 * and every consumer has to know which apply to what. The union gets worse with
 * each adopter; scoping does not.
 *
 * WHAT IS GENUINELY SHARED IS THE ROLE. Read across the three tools that exist:
 *
 *   role             fault-injection   assertion (DocGuard)   scan (websec)
 *   held             killed            pass                   pass, exit 0
 *   broken           survived          fail                   fail, exit 1
 *   not-applicable   nocover           no-matches             not-evaluated
 *   indeterminate    unverifiable…     error / partial        incomplete, exit 2
 *
 * The outcome SPACE is the same four roles in all three. Only the names of the
 * first two differ, because only those carry the method's question. So a name
 * is method-scoped and a role is universal, which is what lets one reader rank
 * and count findings from three tools without knowing which produced them.
 *
 * `gates` is per method and deliberately not uniform. TestGuard gates `nocover`
 * because "no test covers this" IS a finding about your suite — worse than a
 * survivor, since nothing was even tried. DocGuard and websec do not gate their
 * not-applicable, because "this validator had nothing to check" is not a finding
 * about your docs, and websec's own `not-evaluated` exits 0. Both are right;
 * they are answers to different questions.
 */

/** role → what an outcome means, independent of the method that produced it. */
export const ROLES = Object.freeze(['held', 'broken', 'not-applicable', 'indeterminate']);

const V = (role, gates, meaning) => Object.freeze({ role, gates, meaning });

export const VERDICTS = Object.freeze({
  'fault-injection': Object.freeze({
    killed: V('held', false, 'The fault was applied and every confirming run failed by assertion: the defenders detect it.'),
    survived: V('broken', true, 'The fault was applied and every run passed: nothing detects it. The claim is unproven.'),
    nocover: V('not-applicable', true, 'No defending test exists. Worse than a survivor — nothing was even tried — which is why this gates where another method\'s not-applicable does not.'),
    unverifiable: V('indeterminate', true, 'The claim could not be probed: a missing or ambiguous anchor, defenders that failed to load, a subject the defenders never execute, or a probe that threw.'),
    timeout: V('indeterminate', true, 'A run exceeded its budget. Not a detection; the pessimistic reading is the safe one.'),
    'fault-invalid': V('indeterminate', true, 'The replacement does not load or compile. A bad fault, not a detection.'),
    'flaky-defender': V('indeterminate', true, 'The defenders were not green N/N unmodified, or the N runs disagreed. No verdict about the fault can be trusted.'),
  }),
  // assertion and scan share a vocabulary because they share a QUESTION — is
  // this true now — and differ only in what they look at. Giving each its own
  // synonyms would be inventing vocabulary for tools that are not in the room,
  // which is the mistake this whole change exists to correct.
  assertion: Object.freeze({
    holds: V('held', false, 'The claim was checked against the code and no contradiction was found.'),
    violated: V('broken', true, 'A contradiction was found: the claim is false as written.'),
    'not-applicable': V('not-applicable', false, 'There was nothing to check — no artifact matched. Not a finding about the project, so it does not gate.'),
    unverifiable: V('indeterminate', true, 'The check could not reach an answer: it errored, or completed only partially.'),
  }),
  scan: Object.freeze({
    holds: V('held', false, 'The surface was scanned and no violation was found.'),
    violated: V('broken', true, 'A violation was found on the scanned surface.'),
    'not-applicable': V('not-applicable', false, 'Nothing was evaluated — the surface was out of scope or absent. Not a finding, so it does not gate.'),
    unverifiable: V('indeterminate', true, 'The scan could not complete, so its silence means nothing.'),
  }),
});

/** Absent means fault-injection, so every document written before methods existed keeps its rules. */
export const methodOf = (x) => x?.method ?? 'fault-injection';

/** Every verdict name any method may emit. The schema uses this; the validator enforces the scoping. */
export const ALL_VERDICTS = Object.freeze([...new Set(Object.values(VERDICTS).flatMap((m) => Object.keys(m)))].sort());

/** May this method emit this verdict? */
export const isVerdictOf = (method, verdict) => Boolean(VERDICTS[method]?.[verdict]);

/** What does this outcome MEAN, regardless of which tool produced it? */
export const roleOf = (method, verdict) => VERDICTS[method]?.[verdict]?.role;

/** Does this outcome turn CI red under its own method's rules? */
export const gatesUnder = (method, verdict) => VERDICTS[method]?.[verdict]?.gates ?? false;

/** The passing verdicts of one method. Passing is a per-method question, because "does this pass" has always depended on what was asked. */
export const passingVerdicts = (method) => Object.entries(VERDICTS[method] ?? {}).filter(([, v]) => !v.gates).map(([k]) => k);

/**
 * How urgently a role wants attention, worst first. Used to rank findings, and
 * the reason a role exists at all: a reader can sort a document from any tool
 * without knowing which verdict names that tool uses.
 *
 * `broken` before `not-applicable` before `indeterminate`: a claim proved false
 * is worse than one nothing was tried on, which is worse than one where the
 * attempt itself failed and says nothing either way.
 */
export const ROLE_ORDER = Object.freeze(['broken', 'not-applicable', 'indeterminate', 'held']);

/** Sort key for one record's verdict under its method. Unknown pairs sort last, never first. */
export function verdictOrder(method, verdict) {
  const i = ROLE_ORDER.indexOf(roleOf(method, verdict));
  return i === -1 ? ROLE_ORDER.length : i;
}
