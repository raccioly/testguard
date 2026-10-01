import { validate } from '../../spec/lib/validate.mjs';

const injection = (fault) => (fault.method ?? 'fault-injection') === 'fault-injection';
// A different explicit defender selection is a different measurement, even
// when the injected bytes match. Absence and explicit [] must stay distinct.
const anchorKey = (fault) => JSON.stringify([
  fault.file, fault.faultClass, fault.find, fault.replace,
  fault.expectHits ?? 1, fault.occurrence ?? 1,
  Object.hasOwn(fault, 'defendedBy') ? [...fault.defendedBy].sort() : null,
]);

function conforming(label, doc) {
  const result = validate('claims', doc);
  if (!result.ok) throw new Error(`non-conforming ${label}: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
}

/** Pure draft merge only. The future CLI owns all file admission/publication. */
export function appendDraft({ draft, proposals, claimId }) {
  conforming('draft', draft);
  conforming('proposals', proposals);
  if (typeof claimId !== 'string' || !claimId) throw new Error('append requires one existing claim ID');
  const doc = structuredClone(draft);
  const target = doc.claims.find((claim) => claim.id === claimId);
  if (!target) throw new Error('append selection does not name an existing draft claim');
  const candidates = proposals.claims.flatMap((claim) => claim.faults);
  if (candidates.some((fault) => !injection(fault))) throw new Error('append proposals require fault-injection methods');
  const seen = new Set(target.faults.filter(injection).map(anchorKey));
  const used = new Set(target.faults.map((fault) => fault.id));
  let next = 1;
  for (const candidate of candidates) {
    const key = anchorKey(candidate);
    if (seen.has(key)) continue;
    while (used.has(`S${next}`)) next++;
    const id = `S${next++}`;
    used.add(id);
    target.faults.push({ ...structuredClone(candidate), id });
    seen.add(key);
  }
  conforming('appended draft', doc);
  return doc;
}
