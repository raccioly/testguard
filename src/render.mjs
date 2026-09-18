import { methodOf, gatesUnder, verdictOrder, VERDICTS } from '../spec/lib/verdicts.mjs';

// Ordering is by ROLE, not by a hard-coded list of fault-injection's words, so
// a document from any method sorts correctly. The role exists for exactly this:
// a reader ranks findings without knowing which tool produced them.
const orderOf = (method) => (v) => verdictOrder(method, v);

/** Non-passing verdicts shout; the one pass does not. */
export const formatVerdict = (v, provisional = false) => (v === 'killed' ? 'killed' : v.toUpperCase()) + (provisional ? '?' : '');

export const PROVISIONAL_WARNING = (n) => `PROVISIONAL — confirmRuns ${n} (< 3): nothing below is confirmed. Verdicts carry a "?"; this evidence cannot be frozen into a baseline. Re-run with --confirm 3 before trusting it.`;

export function renderRecord(r, { provisional = false, showDiscovered = true } = {}) {
  const head = `${formatVerdict(r.verdict, provisional).padEnd(15)} ${r.claim.id}/${r.subject.id}`.padEnd(38);
  let why = '';
  if (r.detail.reason === 'killed-by-undeclared-tests' && r.detail.undeclaredKillers?.length) {
    const files = [...new Set(r.detail.undeclaredKillers.map((k) => k.split('::')[0]))];
    why = `  [killed-by-undeclared-tests: ${files.join(', ')}]`;
  } else if (r.detail.reason === 'anchor-ambiguous' && r.detail.anchor) {
    why = `  [anchor-ambiguous: ${r.detail.anchor.hits} hits, expected ${r.detail.anchor.expected}]`;
  } else if (r.detail.reason) {
    why = `  [${r.detail.reason}]`;
  }
  if (r.defenders.discovered && showDiscovered) why += '  (defenders discovered by import)';
  return `${head} ${r.claim.severity.padEnd(8)} ${r.subject.file}  ${r.subject.description}${why}`;
}

export function summarize(records) {
  const byVerdict = {};
  for (const r of records) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  return byVerdict;
}

export function renderSummary(records, run) {
  const byVerdict = summarize(records);
  const method = methodOf(run);
  const parts = Object.keys(VERDICTS[method] ?? VERDICTS['fault-injection'])
    .sort((a, b) => orderOf(method)(a) - orderOf(method)(b))
    .filter((v) => byVerdict[v])
    .map((v) => `${byVerdict[v]} ${formatVerdict(v, run?.provisional)}`);
  const unproven = records.filter((r) => gatesUnder(method, r.verdict));
  const claims = new Set(unproven.map((r) => r.claim.id)).size;
  const where = run ? ` Probed ${run.repo.snapshot ? `working tree (snapshot ${run.repo.snapshot.slice(0, 7)} of ${run.repo.head.slice(0, 7)})` : run.mode === 'in-place' ? `in place at ${run.repo.head.slice(0, 7)}${run.repo.dirty ? ' (dirty)' : ''}` : run.repo.head.slice(0, 7)}.` : '';
  return `${run?.provisional ? 'PROVISIONAL: ' : ''}${records.length} faults probed: ${parts.join(', ')}. ${unproven.length} unproven fault${unproven.length === 1 ? '' : 's'} across ${claims} claim${claims === 1 ? '' : 's'}.${where}`;
}

/**
 * Worst first, then by rank score, passing last. `run` is optional: without it
 * the method is fault-injection, which is what every document written before
 * methods existed is.
 */
export function sortForReport(records, run) {
  const method = methodOf(run);
  return [...records].sort((a, b) => verdictOrder(method, a.verdict) - verdictOrder(method, b.verdict) || (b.rank?.score ?? 0) - (a.rank?.score ?? 0));
}
