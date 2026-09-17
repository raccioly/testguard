import { createHash } from 'node:crypto';

/**
 * The one fingerprint derivation every Guard-spec tool must use.
 *
 * Built from identities and outcome only — never from the fault's find/replace
 * text — so repairing a rotted anchor does not churn a baseline, while a
 * change of verdict on the same claim+subject surfaces as a new finding.
 *
 * `file` is the empty string when the subject has no file (non-TestGuard adopters).
 */
export function fingerprint({ claimId, subjectId, file = '', verdict }) {
  for (const [k, v] of Object.entries({ claimId, subjectId, verdict })) {
    if (typeof v !== 'string' || v.length === 0) throw new TypeError(`fingerprint: ${k} is required`);
  }
  return createHash('sha256')
    .update([claimId, subjectId, file, verdict].join('\n'))
    .digest('hex');
}
