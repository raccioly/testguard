const ORDER = ['survived', 'nocover', 'unverifiable', 'fault-invalid', 'timeout', 'flaky-defender', 'killed'];

/** Non-passing verdicts shout; the one pass does not. */
export const formatVerdict = (v) => (v === 'killed' ? 'killed' : v.toUpperCase());

export function renderRecord(r) {
  const head = `${formatVerdict(r.verdict).padEnd(15)} ${r.claim.id}/${r.subject.id}`.padEnd(38);
  let why = '';
  if (r.detail.reason === 'killed-by-undeclared-tests' && r.detail.undeclaredKillers?.length) {
    const files = [...new Set(r.detail.undeclaredKillers.map((k) => k.split('::')[0]))];
    why = `  [killed-by-undeclared-tests: ${files.join(', ')}]`;
  } else if (r.detail.reason === 'anchor-ambiguous' && r.detail.anchor) {
    why = `  [anchor-ambiguous: ${r.detail.anchor.hits} hits, expected ${r.detail.anchor.expected}]`;
  } else if (r.detail.reason) {
    why = `  [${r.detail.reason}]`;
  }
  if (r.defenders.discovered) why += '  (defenders discovered by import)';
  return `${head} ${r.claim.severity.padEnd(8)} ${r.subject.file}  ${r.subject.description}${why}`;
}

export function summarize(records) {
  const byVerdict = {};
  for (const r of records) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  return byVerdict;
}

export function renderSummary(records, run) {
  const byVerdict = summarize(records);
  const parts = ORDER.filter((v) => byVerdict[v]).map((v) => `${byVerdict[v]} ${formatVerdict(v)}`);
  const unproven = records.filter((r) => r.verdict !== 'killed');
  const claims = new Set(unproven.map((r) => r.claim.id)).size;
  const where = run ? ` Probed ${run.repo.snapshot ? `working tree (snapshot ${run.repo.snapshot.slice(0, 7)} of ${run.repo.head.slice(0, 7)})` : run.mode === 'in-place' ? `in place at ${run.repo.head.slice(0, 7)}${run.repo.dirty ? ' (dirty)' : ''}` : run.repo.head.slice(0, 7)}.` : '';
  return `${records.length} faults probed: ${parts.join(', ')}. ${unproven.length} unproven fault${unproven.length === 1 ? '' : 's'} across ${claims} claim${claims === 1 ? '' : 's'}.${where}`;
}

/** Survivors first, then by rank score; killed last. */
export function sortForReport(records) {
  return [...records].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) || (b.rank?.score ?? 0) - (a.rank?.score ?? 0));
}
