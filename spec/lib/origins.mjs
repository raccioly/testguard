import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

// One vocabulary for admission and reporting; never an evidence-strength order.
const common = JSON.parse(readFileSync(new URL('../schemas/common.schema.json', import.meta.url), 'utf8'));
export const CLAIM_SOURCE_KINDS = Object.freeze([...common.$defs.claimSourceKind.enum]);
const kindSet = new Set(CLAIM_SOURCE_KINDS);
const counts = () => Object.fromEntries(CLAIM_SOURCE_KINDS.map((kind) => [kind, 0]));

// Consumers validate their full document first. These narrow guards prevent
// malformed direct calls from silently manufacturing a meaningful summary.
function declaration(claim) {
  const source = claim?.source;
  if (typeof claim?.id !== 'string' || !claim.id || !kindSet.has(source?.kind)
    || Object.keys(source).some((key) => key !== 'kind' && key !== 'ref')
    || (Object.hasOwn(source, 'ref') && (typeof source.ref !== 'string' || source.ref.length > 512))) {
    throw new TypeError('origin summary needs valid claim identities and declared sources');
  }
  return { kind: source.kind, ...(Object.hasOwn(source, 'ref') ? { ref: source.ref } : {}) };
}

/** Current declarations only: fault multiplicity cannot inflate claim counts. */
export function declaredOriginSummary(claims) {
  const byKind = counts();
  const seen = new Set();
  for (const claim of claims) {
    const source = declaration(claim);
    if (seen.has(claim.id)) throw new TypeError('duplicate declared claim identity');
    seen.add(claim.id);
    byKind[source.kind]++;
  }
  return { basis: 'declared', claims: { total: seen.size, byKind, mixed: 0 } };
}

/** Actual recorded projections only; no current-claims relabeling or filtering. */
export function recordedOriginSummary(records) {
  const recordKinds = counts();
  const claims = new Map();
  for (const record of records) {
    const source = declaration(record.claim);
    recordKinds[source.kind]++;
    const previous = claims.get(record.claim.id);
    if (!previous) claims.set(record.claim.id, { source, mixed: false });
    else if (!isDeepStrictEqual(previous.source, source)) previous.mixed = true;
  }
  const byKind = counts();
  let mixed = 0;
  for (const claim of claims.values()) {
    if (claim.mixed) mixed++;
    else byKind[claim.source.kind]++;
  }
  return {
    basis: 'recorded', claims: { total: claims.size, byKind, mixed },
    records: { total: records.length, byKind: recordKinds },
  };
}
