/**
 * The three kinds of check. Each returns data, never a boolean alone, so the
 * scorecard can say exactly what differed.
 *
 *  - against the key: the answer derived by hand, never from TestGuard;
 *  - differential: a mode against the reference mode on the same commit;
 *  - metamorphic: a transformed subject against the reference.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS } from './subject.mjs';

/** The key for one mode: the base entries with that mode's declared overrides. */
export function expectedFor(subject, mode) {
  const base = subject.key.expected;
  const overrides = subject.key.modes?.[mode]?.expected ?? {};
  const out = {};
  for (const [id, e] of Object.entries(base)) out[id] = overrides[id] ?? e;
  return out;
}

/**
 * Known failures are reviewed entries, each naming a filed issue and the exact
 * observation it excuses. A changed observation is not excused. A `killed`
 * where the key says otherwise is never excusable, and an entry that tries is
 * refused when the file is read.
 */
export function loadKnownFailures(path = join(CORPUS, 'known-failures.json')) {
  if (!existsSync(path)) return [];
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  for (const k of doc.entries ?? []) {
    if (!Number.isInteger(k.issue) || k.issue < 1) throw new Error(`known-failures.json: ${k.subject} ${k.fault} names no issue number`);
    const selection = k.check?.startsWith('selection:') && Array.isArray(k.observed?.selected);
    const stale = k.check === 'nothing-left-stale' && Array.isArray(k.observed?.stale) && k.observed.stale.length > 0;
    if (k.check && !selection && !stale) throw new Error(`known-failures.json: ${k.subject} ${k.check}: only a --changed selection or a converged record left stale can be a known check failure`);
    if (k.observed?.verdict === 'killed' && k.expected?.verdict !== 'killed') throw new Error(`known-failures.json: ${k.subject} ${k.fault} would excuse a false kill; a critical failure is never known`);
  }
  return doc.entries ?? [];
}

const same = (a, b) => (a?.verdict ?? null) === (b?.verdict ?? null) && (a?.reason ?? null) === (b?.reason ?? null);

function knownFor(known, subject, mode, id, observed) {
  return known.find((k) => !k.check && k.subject === subject && k.fault === id && (k.modes === undefined || k.modes.includes(mode))
    && k.observed?.verdict === observed?.verdict && (k.observed?.reason ?? null) === (observed?.reason ?? null)) ?? null;
}

/**
 * Compares observed verdicts with the key over `ids` (default: every keyed fault).
 * A fault the run did not report is wrong: an omission is not a match.
 */
export function checkKey({ subject, mode, map, expected, ids, known = [] }) {
  const out = { total: 0, right: 0, wrong: 0, critical: 0, known: 0, mismatches: [] };
  for (const id of ids ?? Object.keys(expected)) {
    const want = expected[id];
    const got = map[id];
    out.total++;
    const killKindOk = want.verdict !== 'killed' || want.killKind === undefined || got?.killKind === want.killKind;
    if (got && same(got, { verdict: want.verdict, reason: want.reason ?? got.reason }) && killKindOk) { out.right++; continue; }
    const critical = got?.verdict === 'killed' && want.verdict !== 'killed';
    const mismatch = { fault: id, expected: { verdict: want.verdict, reason: want.reason, killKind: want.killKind }, observed: got ? { verdict: got.verdict, reason: got.reason, killKind: got.killKind } : null, critical };
    const k = critical ? null : knownFor(known, subject.name, mode, id, got);
    if (critical) out.critical++;
    else if (k) { out.known++; mismatch.knownIssue = k.issue; }
    else out.wrong++;
    out.mismatches.push(mismatch);
  }
  return out;
}

/**
 * A mode against the reference on the same commit: the same verdict, reason
 * and kill kind for every fault the mode reports, and the same record order.
 * `deltas` are the faults whose answer the mode is keyed to change (the type
 * check); they are judged by the key and left out here.
 */
export function differential({ reference, observed, ids, deltas = [] }) {
  const mismatches = [];
  const consider = (ids ?? reference.order).filter((id) => !deltas.includes(id));
  for (const id of consider) {
    const a = reference.map[id];
    const b = observed.map[id];
    if (!b || a.verdict !== b.verdict || (a.reason ?? null) !== (b.reason ?? null) || (a.killKind ?? null) !== (b.killKind ?? null)) {
      mismatches.push({ fault: id, reference: a, observed: b ?? null });
    }
  }
  const wantOrder = reference.order.filter((id) => (ids ?? reference.order).includes(id));
  const gotOrder = observed.order.filter((id) => wantOrder.includes(id));
  const orderEqual = JSON.stringify(wantOrder) === JSON.stringify(gotOrder);
  return { equal: mismatches.length === 0 && orderEqual, compared: consider.length, mismatches, orderEqual };
}

export function check(name, ok, detail) {
  return { check: name, ok: Boolean(ok), detail };
}
