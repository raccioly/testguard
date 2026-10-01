import { planAnnotationPlacement, applyAnnotationPlacement, loadAnnotationClaims } from '../claims/annotation-placement.mjs';
import { validate } from '../../spec/lib/validate.mjs';
import { SpecDocError } from '../evidence/writer.mjs';

/** Authoring is explicitly selected, never an inspection side effect. */
export async function annotationsCommand({ projectDir, path, values, suppliedOptions = Object.keys(values), version }, io) {
  const allowed = new Set(['claims', 'claim', 'annotate', 'apply', 'json']);
  if (!values.annotate || suppliedOptions.some((key) => !allowed.has(key))) {
    io.err('--apply requires --annotate; annotation authoring cannot combine inspection/output switches');
    return 3;
  }
  const claimIds = (values.claim ?? []).flatMap((value) => value.split(','));
  let claims;
  try {
    claims = loadAnnotationClaims(path);
    if (!validate('claims', claims).ok) throw new Error('claims must conform before annotation placement');
  }
  catch { io.err('annotation input refused: claims could not be safely loaded or validated'); return 2; }
  if (claimIds.some((id) => !id || !claims.claims.some((claim) => claim.id === id))) {
    io.err('--claim must name existing non-empty claim IDs');
    return 3;
  }
  const plan = planAnnotationPlacement({ projectDir, claims, claimIds });
  const doc = {
    schemaVersion: 1, tool: { name: 'testguard', version }, mode: values.apply ? 'apply' : 'preview',
    state: plan.applicable ? 'preview' : 'refused', selected: plan.selectedClaimIds,
    targets: plan.files.map(({ file, claimIds, changed }) => ({ file, claimIds, action: changed ? 'add' : 'unchanged' })),
    refused: plan.refused,
  };
  if (values.apply) {
    doc.state = 'refused';
    doc.outcome = { changed: [], touched: [], unchanged: plan.files.filter((f) => !f.changed).map((f) => f.file), failed: [] };
    if (plan.applicable) {
      try {
        const report = applyAnnotationPlacement({ projectDir, claimsPath: path, plan });
        doc.state = report.state;
        doc.outcome = {
          changed: report.changed, touched: report.touched, unchanged: report.unchanged,
          failed: report.failed.map(publicFailure), recoveryDir: report.recoveryDir,
          lockRelease: { released: report.lockRelease.released, ...(report.lockRelease.reason ? { reason: 'owned lock release could not be verified' } : {}) },
        };
      } catch (error) {
        doc.outcome.failed.push(publicFailure({ file: null, stage: 'preparation' }));
        if (error.recoveryDir) doc.outcome.recoveryDir = error.recoveryDir;
        if (error.lockRelease) doc.outcome.lockRelease = { released: error.lockRelease.released, ...(error.lockRelease.reason ? { reason: 'owned lock release could not be verified' } : {}) };
      }
    }
  }
  const checked = validate('annotations', doc);
  if (!checked.ok) throw new SpecDocError(`annotation result does not conform: ${checked.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  if (values.json) io.out(JSON.stringify(doc, null, 2));
  else {
    io.out(`Annotation ${doc.mode}: ${doc.state} — file-level authoring, not verification or intent authentication.`);
    for (const t of doc.targets) io.out(`  ${t.action} ${t.file}: ${t.claimIds.join(', ')}`);
    for (const r of doc.refused) io.out(`  REFUSED ${r.file}: ${r.reason}`);
    for (const f of doc.outcome?.failed ?? []) io.out(`  FAILED ${f.file ?? '(operation)'} [${f.stage}]: ${f.reason}`);
    if (doc.outcome?.recoveryDir) io.out(`Recovery originals retained: ${doc.outcome.recoveryDir}`);
    if (doc.mode === 'preview' && doc.state === 'preview') io.out('No files changed. Review this selection, then rerun with --apply; the plan is recomputed against current files.');
  }
  return doc.state === 'preview' || doc.state === 'applied' ? 0 : 2;
}

// Raw syscall messages may contain absolute source paths. Keep them in the
// private recovery journal, never the public authoring document.
function publicFailure({ file, stage }) {
  return { file, stage, reason: `Annotation ${stage} failed; inspect private recovery details when available.` };
}
