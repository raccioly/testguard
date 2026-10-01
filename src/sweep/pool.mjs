import { validate } from '../../spec/lib/validate.mjs';

const check = (doc) => {
  const result = validate('claims', doc);
  if (!result.ok) throw new Error(`non-conforming sweep draft: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
};

/** Keep per-file drafts distinct before selection, without changing callers. */
export function poolDrafts(drafts) {
  for (const draft of drafts) check(draft);
  const pooled = structuredClone(drafts);
  const entries = pooled.flatMap((draft) => draft.claims.map((claim) => ({ claim, originalId: claim.id, file: claim.faults[0].file ?? '' })));
  entries.sort((a, b) => a.file.localeCompare(b.file) || a.originalId.localeCompare(b.originalId));
  const reserved = new Set(entries.map((entry) => entry.originalId));
  const used = new Set();
  const nextFor = new Map();
  for (const { claim, originalId } of entries) {
    let id = originalId;
    if (used.has(id)) {
      let n = nextFor.get(originalId) ?? 2;
      do {
        const suffix = `-${n++}`;
        id = originalId.slice(0, 128 - suffix.length) + suffix;
      } while (reserved.has(id) || used.has(id));
      nextFor.set(originalId, n);
    }
    claim.id = id;
    used.add(id);
  }
  for (const draft of pooled) check(draft);
  check({ schemaVersion: 1, claims: pooled.flatMap((draft) => draft.claims) });
  return pooled;
}
