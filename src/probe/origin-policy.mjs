import { isDeepStrictEqual } from 'node:util';
import { validate, methodOf } from '../../spec/lib/validate.mjs';
import { CLAIM_SOURCE_KINDS } from '../../spec/lib/origins.mjs';
import { sameClaimMetadata, subjectOf } from './attribution.mjs';
import { sha256 } from '../util/hash.mjs';

/** Admit the planned probe option before loading claims or executing/writing. */
export function originPolicyRequest(values, command = 'probe') {
  const raw = values['require-origin'];
  if (raw === undefined) return undefined;
  if (command !== 'probe') throw new TypeError('--require-origin is only valid on probe');
  if (!Array.isArray(raw) || !raw.length || raw.some((v) => typeof v !== 'string')) {
    throw new TypeError('--require-origin must name declared source kinds');
  }
  const kinds = raw.flatMap((v) => v.split(',').map((k) => k.trim()));
  if (kinds.some((k) => !CLAIM_SOURCE_KINDS.includes(k))) throw new TypeError('--require-origin contains an empty or unsupported kind');
  if (values.claim !== undefined || values['allow-empty'] || values.ref !== undefined || values['ignore-dirty']) {
    throw new TypeError('--require-origin needs a complete current-project run without --claim, --allow-empty, --ref or --ignore-dirty');
  }
  const n = Number(values.confirm ?? 3);
  if (!Number.isInteger(n) || n < 3) throw new TypeError('--require-origin requires --confirm of at least 3');
  return [...new Set(kinds)].sort();
}

/** Internal policy only: fresh must come from the existing input-binding checker. */
export function evaluateOriginPolicy({ claims, evidence, eligibleKinds, fresh }) {
  if (eligibleKinds === undefined) return undefined;
  if (!Array.isArray(eligibleKinds) || !eligibleKinds.length || eligibleKinds.some((k) => !CLAIM_SOURCE_KINDS.includes(k))) {
    throw new TypeError('origin policy needs a nonempty set of declared source kinds');
  }
  const eligible = [...new Set(eligibleKinds)].sort();
  const reasons = new Set();
  const claimsValid = validate('claims', claims).ok;
  const evidenceValid = validate('evidence', evidence).ok;
  if (!claimsValid) reasons.add('invalid-claims');
  if (!evidenceValid) reasons.add('invalid-evidence');
  if (fresh !== true) reasons.add('stale-inputs');
  const current = claimsValid ? claims.claims : [];
  const records = evidenceValid ? evidence.records : [];
  const key = (claimId, faultId) => JSON.stringify([claimId, faultId]);
  const expected = new Map(current.flatMap((claim) => claim.faults.map((fault) => [key(claim.id, fault.id), { claim, fault }])));
  if (!current.length || !expected.size) reasons.add('empty-universe');
  if (evidenceValid && (evidence.run.provisional === true || evidence.run.confirmRuns < 3)) reasons.add('provisional-evidence');
  if (evidenceValid && methodOf(evidence.run) !== 'fault-injection') reasons.add('incompatible-method');
  if (current.some((c) => c.faults.some((f) => methodOf(f) !== 'fault-injection'))) reasons.add('incompatible-method');
  const seen = new Set();
  for (const record of records) {
    const identity = key(record.claim.id, record.subject.id);
    if (seen.has(identity)) reasons.add('duplicate-record');
    seen.add(identity);
    const pair = expected.get(identity);
    if (!pair) { reasons.add('extra-record'); continue; }
    if (!sameClaimMetadata(record.claim, pair.claim)) reasons.add('claim-metadata-mismatch');
    if (methodOf(pair.fault) !== 'fault-injection') continue;
    const subject = subjectOf(pair.fault, sha256);
    if (['kind', 'id', 'file', 'faultClass', 'contentHash'].some((field) => record.subject[field] !== subject[field])
      || !isDeepStrictEqual(record.subject.producedBy, subject.producedBy)) reasons.add('fault-mismatch');
  }
  if ([...expected.keys()].some((identity) => !seen.has(identity))) reasons.add('missing-record');
  const ineligibleClaims = current.filter((c) => !eligible.includes(c.source.kind)).map((c) => c.id).sort();
  const nonKilledFaults = [...new Map(records.filter((r) => r.verdict !== 'killed').map((r) =>
    [key(r.claim.id, r.subject.id), { claimId: r.claim.id, faultId: r.subject.id }])).values()]
    .sort((a, b) => a.claimId.localeCompare(b.claimId) || a.faultId.localeCompare(b.faultId));
  return {
    state: reasons.size ? 'unavailable' : ineligibleClaims.length || nonKilledFaults.length ? 'failed' : 'passed',
    eligibleKinds: eligible, claims: current.length, faults: expected.size,
    ineligibleClaims, nonKilledFaults, unavailableReasons: [...reasons].sort(),
  };
}
