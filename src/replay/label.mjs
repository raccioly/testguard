/**
 * Which injected-fault class does a real fix diff most resemble?
 *
 * This is the join key between ground truth and the fault model: a replayed
 * bug is a real defect a human confirmed, so labelling it by fault class is
 * what lets P(a surviving fault of this class is a real bug) be computed.
 * Without it, a mutation score is a number nobody can interpret.
 *
 * Deterministic and shape-based, in the same spirit as the scaffold
 * producers read in reverse: a fix ADDS what the bug lacked, so the lines a
 * fix adds are the lines a fault would delete. No LLM, and `other` whenever
 * the shape is not one the model has — an honest gap is worth more than a
 * confident wrong label.
 */
const GUARD_RE = /^\s*if\s*\(.*\)\s*\{?\s*$/;
const RETURN_RE = /^\s*return\s+/;
const CALL_RE = /^\s*(?:await\s+)?(?:[\w.]*\.)?(?:verify|validate|check|assert|authorize|authorise|ensure|require)\w*\s*\(/i;
const FIELD_RE = /^\s*['"`]?[\w$]+['"`]?\s*:\s*.+,\s*$/;
const LITERAL_RE = /\b(?:httpOnly|secure|sameSite|rounds|cost|ttl|timeout|tolerance|window|limit|maxAge|expiresIn)\b\s*[:=]/i;
const ASSIGN_RE = /^\s*(?:const |let |var )?[\w.[\]$]+\s*=\s*[^=]/;

/** Most specific first; a tie between equally specific shapes is not a label. */
const SPECIFICITY = ['literal-changed', 'call-removed', 'exception-swallowed', 'field-dropped', 'guard-removed', 'return-altered', 'statement-deleted'];

function kind(line) {
  if (LITERAL_RE.test(line)) return 'literal-changed';
  if (/^\s*(?:\}\s*)?catch\b/.test(line) || /^\s*throw\b/.test(line)) return 'exception-swallowed';
  if (GUARD_RE.test(line)) return 'guard-removed';
  if (RETURN_RE.test(line)) return 'return-altered';
  if (CALL_RE.test(line)) return 'call-removed';
  if (FIELD_RE.test(line)) return 'field-dropped';
  if (ASSIGN_RE.test(line)) return 'statement-deleted';
  return null;
}

/**
 * Label a unified diff of the fix's SOURCE changes (never its tests).
 *
 * Added lines carry the signal at double weight: the fix put back the guard,
 * the field or the call that was missing. Removed lines are read too, for the
 * fixes that delete a wrong condition rather than add a right one.
 */
export function labelDiff(diff) {
  const added = [];
  const removed = [];
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) added.push(raw.slice(1));
    else if (raw.startsWith('-')) removed.push(raw.slice(1));
  }
  const tally = new Map();
  const add = (k, weight) => {
    if (k) tally.set(k, (tally.get(k) ?? 0) + weight);
  };
  for (const l of added) add(kind(l), 2);
  for (const l of removed) add(kind(l), 1);
  if (tally.size === 0) return { faultClass: 'other', confident: false };

  const ranked = [...tally].sort((a, b) => b[1] - a[1] || SPECIFICITY.indexOf(a[0]) - SPECIFICITY.indexOf(b[0]));
  const [top, topWeight] = ranked[0];
  const tiedSameSpecificity = ranked.length > 1 && ranked[1][1] === topWeight && SPECIFICITY.indexOf(ranked[1][0]) === SPECIFICITY.indexOf(top);
  if (tiedSameSpecificity) return { faultClass: 'other', confident: false };
  return { faultClass: top, confident: topWeight >= 2 };
}
