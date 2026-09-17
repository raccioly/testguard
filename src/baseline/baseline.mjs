const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Freeze every non-passing finding. `killed` is never debt, so it is never
 * fingerprinted. When the evidence came from a working-tree snapshot, the
 * baseline says so (`snapshot`): its `head` is then the parent of the commit
 * that will carry the tests, and `baseline --restamp` moves it once a clean
 * probe of that commit reproduces the same fingerprints.
 */
export function buildBaseline(evidence, { createdAt = new Date().toISOString() } = {}) {
  const fingerprints = {};
  for (const r of evidence.records) {
    if (r.verdict === 'killed') continue;
    fingerprints[r.fingerprint] = (fingerprints[r.fingerprint] ?? 0) + 1;
  }
  const repo = evidence.run.repo;
  return { schemaVersion: 1, tool: evidence.tool, createdAt, head: repo.head, dirty: repo.dirty, ...(repo.snapshot ? { snapshot: repo.snapshot } : {}), fingerprints };
}

/** Same fingerprints, same counts. */
export const sameFingerprints = (a, b) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};

/**
 * Re-stamp a baseline's `head`/`dirty` from a later, CLEAN probe that
 * reproduced exactly the same fingerprints. A frozen contract is never
 * silently rewritten: different fingerprints, a dirty tree or a snapshot run
 * are refused with the reason, and the caller re-probes and re-baselines.
 */
export function restampBaseline(baseline, evidence, { restampedAt = new Date().toISOString() } = {}) {
  const repo = evidence.run.repo;
  if (repo.snapshot || repo.dirty) return { ok: false, reason: `the evidence is from a ${repo.snapshot ? 'working-tree snapshot' : 'dirty tree'}; re-stamping needs a clean probe of the commit that carries the tests` };
  const current = buildBaseline(evidence).fingerprints;
  if (!sameFingerprints(baseline.fingerprints, current)) return { ok: false, reason: 'the current evidence does not reproduce the baseline\'s fingerprints; re-probe and run `testguard baseline` to freeze the new set instead' };
  const { snapshot, ...rest } = baseline;
  return { ok: true, baseline: { ...rest, head: repo.head, dirty: false, restampedAt } };
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
