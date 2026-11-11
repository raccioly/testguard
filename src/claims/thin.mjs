/**
 * `claim-thin`: a claim whose faults are too few or too alike to say much when
 * they are all killed. Advisory by construction: it never changes a state, an
 * exit code or a verdict. A claim with one fault is proven against one way of
 * being wrong; a claim whose faults all share a class is proven against one
 * kind of wrong. Pure.
 */
export const THIN_SIGNAL = 'claim-thin';

export function thinClaims(claims) {
  const out = [];
  for (const claim of claims) {
    const classes = [...new Set(claim.faults.map((fault) => fault.faultClass))].sort();
    const reason = claim.faults.length < 2 ? 'fewer-than-two-faults' : classes.length < 2 ? 'single-fault-class' : null;
    if (reason) out.push({ claimId: claim.id, signal: THIN_SIGNAL, reason, faults: claim.faults.length, faultClasses: classes });
  }
  return out;
}

export const renderThin = (thin) => thin.length === 0 ? [] : [
  `advisory: ${thin.length} claim${thin.length === 1 ? ' is' : 's are'} thin (${THIN_SIGNAL}): ${thin.slice(0, 5).map((t) => `${t.claimId} (${t.reason === 'fewer-than-two-faults' ? `${t.faults} fault${t.faults === 1 ? '' : 's'}` : `all ${t.faultClasses[0]}`})`).join(', ')}${thin.length > 5 ? ', …' : ''}. A kill of one fault, or of faults of one class, is weak evidence the claim holds.`,
];
