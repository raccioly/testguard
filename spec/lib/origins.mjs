import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

// One vocabulary for admission and reporting; never an evidence-strength order.
const common = JSON.parse(readFileSync(new URL('../schemas/common.schema.json', import.meta.url), 'utf8'));
export const CLAIM_SOURCE_KINDS = Object.freeze([...common.$defs.claimSourceKind.enum]);
const kindSet = new Set(CLAIM_SOURCE_KINDS);

/**
 * A structured requirement reference, `req:<spec-id>#<requirement-id>`, read
 * from the one pattern the shared schema declares (`$defs/claimSource`). It is
 * a declaration: nothing here resolves the spec or checks the requirement
 * exists. Consumers compare `specId#requirementId` exactly.
 */
const sourceRef = common.$defs.claimSource.properties.ref.pattern;
// The schema's second alternative is the structured form; the first keeps every other ref opaque.
export const REQUIREMENT_REF_PATTERN = new RegExp(`^${sourceRef.slice(sourceRef.indexOf('|^') + 2)}`, 'u');
const REQUIREMENT_REF_PARTS = /^req:([^#]+)#(.+)$/u;

/** `{ specId, requirementId }` for a valid structured `spec` reference; `null` for anything else. */
export function requirementRef(source) {
  if (!source || typeof source !== 'object' || source.kind !== 'spec' || typeof source.ref !== 'string') return null;
  if (!REQUIREMENT_REF_PATTERN.test(source.ref)) return null;
  const [, specId, requirementId] = REQUIREMENT_REF_PARTS.exec(source.ref);
  return { specId, requirementId };
}
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
