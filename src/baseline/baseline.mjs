const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

/** Freeze every non-passing finding. `killed` is never debt, so it is never fingerprinted. */
export function buildBaseline(evidence, { createdAt = new Date().toISOString() } = {}) {
  const fingerprints = {};
  for (const r of evidence.records) {
    if (r.verdict === 'killed') continue;
    fingerprints[r.fingerprint] = (fingerprints[r.fingerprint] ?? 0) + 1;
  }
  return { schemaVersion: 1, tool: evidence.tool, createdAt, head: evidence.run.repo.head, dirty: evidence.run.repo.dirty, fingerprints };
}

/**
 * Split records into what gates and what does not. Baseline suppression is
 * up-to-count per fingerprint; the severity floor only decides whether a
 * new finding turns CI red, never whether it is reported.
 */
export function gate(records, baseline, { severityFloor = 'low' } = {}) {
  const remaining = { ...(baseline?.fingerprints ?? {}) };
  const out = { new: [], baselined: [], belowFloor: [], killed: [] };
  for (const r of records) {
    if (r.verdict === 'killed') {
      out.killed.push(r);
    } else if ((remaining[r.fingerprint] ?? 0) > 0) {
      remaining[r.fingerprint]--;
      out.baselined.push(r);
    } else if (SEVERITY_RANK[r.claim.severity] < SEVERITY_RANK[severityFloor]) {
      out.belowFloor.push(r);
    } else {
      out.new.push(r);
    }
  }
  return out;
}
