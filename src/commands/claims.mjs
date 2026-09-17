import { resolve } from 'node:path';
import { loadClaims, defaultClaimsPath } from '../claims/load.mjs';
import { scanAnnotations, reconcile } from '../claims/annotations.mjs';
import { resolveDefenders } from '../probe/runner-vitest.mjs';

export async function claimsCommand({ projectDir, values }, io) {
  const path = values.claims ? resolve(values.claims) : defaultClaimsPath(projectDir);
  const claims = loadClaims(path);
  const annotations = scanAnnotations(projectDir);
  const drift = reconcile(claims, annotations);

  if (values.json) {
    io.out(JSON.stringify({ path, claims, annotations, drift }, null, 2));
  } else {
    const annotated = new Set(drift.annotated);
    io.out(`${claims.claims.length} claims in ${path} — ${annotated.size} carry a @claim annotation in source (test files are not scanned)`);
    io.out('');
    for (const c of claims.claims) {
      const defenders = resolveDefenders(projectDir, c.defendedBy);
      const cover = defenders.length ? `${defenders.length} defender${defenders.length === 1 ? '' : 's'}` : 'NO DEFENDER';
      io.out(`${annotated.has(c.id) ? '@ ' : '  '}${c.id.padEnd(14)} ${c.severity.padEnd(8)} ${c.source.kind.padEnd(10)} ${String(c.faults.length).padStart(2)} fault${c.faults.length === 1 ? ' ' : 's'}  ${cover.padEnd(12)}  ${c.statement}`);
    }
    if (drift.undeclared.length || drift.stale.length) io.out('');
    for (const a of drift.undeclared) io.out(`UNDECLARED   @claim ${a.id} at ${a.file}:${a.line} has no entry in the claims file — a claim with no fault model`);
    for (const c of drift.stale) io.out(`STALE        ${c.id} is annotation-sourced but no source file carries @claim ${c.id}`);
  }
  return drift.undeclared.length || drift.stale.length ? 1 : 0;
}
