const ORDER = ['survived', 'nocover', 'unverifiable', 'fault-invalid', 'timeout', 'flaky-defender', 'killed'];

/** Non-passing verdicts shout; the one pass does not. */
export const formatVerdict = (v) => (v === 'killed' ? 'killed' : v.toUpperCase());

export function renderRecord(r) {
  const head = `${formatVerdict(r.verdict).padEnd(15)} ${r.claim.id}/${r.subject.id}`.padEnd(38);
  const why = r.detail.reason ? `  [${r.detail.reason}]` : '';
  return `${head} ${r.claim.severity.padEnd(8)} ${r.subject.file}  ${r.subject.description}${why}`;
}

export function summarize(records) {
  const byVerdict = {};
  for (const r of records) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  return byVerdict;
}

export function renderSummary(records) {
  const byVerdict = summarize(records);
  const parts = ORDER.filter((v) => byVerdict[v]).map((v) => `${byVerdict[v]} ${formatVerdict(v)}`);
  const unproven = records.filter((r) => r.verdict !== 'killed');
  const claims = new Set(unproven.map((r) => r.claim.id)).size;
  return `${records.length} faults probed: ${parts.join(', ')}. ${unproven.length} unproven fault${unproven.length === 1 ? '' : 's'} across ${claims} claim${claims === 1 ? '' : 's'}.`;
}

/** Survivors first, then by rank score; killed last. */
export function sortForReport(records) {
  return [...records].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) || (b.rank?.score ?? 0) - (a.rank?.score ?? 0));
}
