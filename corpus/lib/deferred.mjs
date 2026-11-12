/**
 * Comparisons and completeness that cannot be decided inside one shard (#305).
 *
 * The Playwright gallery's reference run is its own CI job; every mode that
 * only COMPARES its answers with the reference's emits them (`row.pending`)
 * and this module judges them when the shards are merged. Nothing here is
 * optional: a comparison without its reference, a reference of another
 * subject or size, a slice set that does not cover every fault exactly once
 * and a mode that applies with no shard are all failures, never skipped checks.
 */
import { differential } from './checks.mjs';
import { MODES, applies } from './modes.mjs';

const failRow = (subject, mode, check, detail) => ({
  subject, mode, ok: false, error: null, faults: null, mismatches: [], differential: null,
  checks: [{ check, ok: false, detail }], runs: [], runnerInvocations: null, seconds: 0, normalizedSeconds: null, speedup: null, noEvidence: [],
});

/** Resolve every row's deferred comparisons against its subject's reference row. Returns new rows, with `pending` and `observed` consumed. */
export function resolveDeferred(rows) {
  const references = new Map();
  for (const r of rows) if (r.mode === 'reference' && r.observed && !references.has(r.subject)) references.set(r.subject, r);
  const extra = [];
  const out = rows.map((row) => {
    const { pending, observed, ...rest } = row;
    if (!pending?.length) return rest;
    const ref = references.get(row.subject)?.observed;
    const bad = (check, detail) => ({ ...rest, ok: false, checks: [...rest.checks, { check, ok: false, detail }], differential: { equal: false, compared: 0, orderEqual: false, mismatches: [] } });
    if (!ref) return bad('differential-reference-present', `no reference result for ${row.subject}: the comparison cannot be made`);
    let combined = { equal: true, compared: 0, orderEqual: true, mismatches: [] };
    for (const p of pending) {
      // A reference of another subject, or a partial one, is not the oracle.
      if (ref.subject !== row.subject || ref.faultCount !== p.faultCount || ref.order.length !== p.faultCount) {
        return bad('differential-reference-complete', `reference has ${ref.order.length} of ${ref.faultCount} faults for ${ref.subject}; this mode measured ${p.faultCount} for ${row.subject}`);
      }
      const reference = { map: ref.map, order: p.referenceOrder ?? ref.order };
      const d = differential({ reference, observed: p.observed, ids: p.ids, deltas: p.deltas });
      combined = { equal: combined.equal && d.equal, compared: combined.compared + d.compared, orderEqual: combined.orderEqual && d.orderEqual, mismatches: [...combined.mismatches, ...d.mismatches] };
    }
    const referenceMs = (references.get(row.subject).runs ?? []).reduce((s, x) => s + x.elapsedMs, 0);
    const ms = rest.runs.reduce((s, x) => s + x.elapsedMs, 0);
    return { ...rest, ok: rest.ok && combined.equal, differential: combined, speedup: referenceMs && rest.runs.length === 1 && ms ? Math.round((referenceMs / ms) * 100) / 100 : rest.speedup };
  });
  // A sliced mode (claim halves): every slice present once, and together every fault exactly once.
  const groups = new Map();
  for (const r of out) if (r.slice) { const k = `${r.subject}\0${r.mode}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  for (const [k, slices] of groups) {
    const [subject, mode] = k.split('\0');
    const of = slices[0].slice.of;
    const ref = references.get(subject)?.observed;
    const indexes = slices.map((s) => s.slice.index).sort((a, b) => a - b);
    const want = Array.from({ length: of }, (_, i) => i + 1);
    const seen = slices.flatMap((s) => s.slice.faults);
    const dup = seen.filter((f, i) => seen.indexOf(f) !== i);
    const missing = ref ? ref.order.filter((f) => !seen.includes(f)) : null;
    const stray = ref ? seen.filter((f) => !ref.order.includes(f)) : [];
    if (slices.some((s) => s.slice.of !== of) || JSON.stringify(indexes) !== JSON.stringify(want) || dup.length || missing === null || missing.length || stray.length) {
      extra.push(failRow(subject, mode, 'slices-cover-every-fault-exactly-once', { slices: indexes, of, duplicated: dup, missing, unknown: stray, reference: ref ? 'present' : 'absent' }));
    }
  }
  return [...out, ...extra];
}

/**
 * Every mode that applies to a subject has a row; every one that does not is
 * recorded as such, from the same `applies()` the harness uses. `subjects` is
 * `[{ name, config, key }]` as `loadSubject` returns them.
 */
export function completeness(rows, subjects) {
  const extra = [];
  for (const subject of subjects) {
    for (const mode of MODES) {
      const has = rows.some((r) => r.subject === subject.name && r.mode === mode);
      if (applies(mode, subject)) {
        if (!has) extra.push(failRow(subject.name, mode, 'mode-has-a-shard', 'this mode applies to the subject and no shard ran it'));
      } else if (!has) {
        extra.push({ ...failRow(subject.name, mode, 'not-applicable', 'not applicable to this subject'), ok: true, checks: [{ check: 'not-applicable', ok: true, detail: 'not applicable to this subject' }] });
      }
    }
  }
  return [...rows, ...extra];
}
