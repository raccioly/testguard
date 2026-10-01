import { isDeepStrictEqual } from 'node:util';
import { admitDraftAppend } from './admission.mjs';
import { appendDraft } from './append.mjs';
import { scaffoldFile } from './scaffold.mjs';

const MAX_PROPOSALS = 4096;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function boundedLimit(value, ceiling, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > ceiling) throw new Error(`${name} must be a non-negative safe integer no greater than ${ceiling}`);
  return value;
}

function outputOf(doc, maxOutputBytes) {
  const output = JSON.stringify(doc, null, 2) + '\n';
  if (Buffer.byteLength(output, 'utf8') > maxOutputBytes) throw new Error('draft append output byte limit exceeded');
  return output;
}

/** Read-only generation. Lower internal limits may tighten, never raise caps. */
export function planDraftAppend({ maxProposals = MAX_PROPOSALS, maxOutputBytes = MAX_OUTPUT_BYTES, toolVersion = '0.0.0', ...request }) {
  boundedLimit(maxProposals, MAX_PROPOSALS, 'maxProposals');
  boundedLimit(maxOutputBytes, MAX_OUTPUT_BYTES, 'maxOutputBytes');
  const inputs = admitDraftAppend(request);
  let doc = structuredClone(inputs.draft.doc);
  let output = outputOf(doc, maxOutputBytes);
  let generated = 0;
  const initialFaults = doc.claims.find((claim) => claim.id === inputs.claimId).faults.length;
  for (const input of inputs.sources) {
    const proposed = scaffoldFile({ projectDir: inputs.projectDir, file: input.file, source: input.source, claimId: inputs.claimId, toolVersion, maxProposals: maxProposals - generated });
    generated += proposed.stats.proposals;
    doc = appendDraft({ draft: doc, proposals: proposed.doc, claimId: inputs.claimId });
    output = outputOf(doc, maxOutputBytes);
  }
  const appended = doc.claims.find((claim) => claim.id === inputs.claimId).faults.length - initialFaults;
  return { ...inputs, doc, output, changed: !isDeepStrictEqual(doc, inputs.draft.doc), stats: { targets: inputs.sources.length, generated, appended } };
}
