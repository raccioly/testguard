import { performance } from 'node:perf_hooks';
import { intentInputRequest } from './request.mjs';
import { admitIntentDocument } from './admission.mjs';
import { readScopedFixCommitInventory } from './fix-input.mjs';
import { writeSpecDoc } from '../evidence/writer.mjs';

function freezeOwned(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

/** Validated read-only metadata, not a claim, a measurement or write authorization. */
export function planIntentInput({ projectDir, command = 'scaffold', values, suppliedOptions = [], files = [], toolVersion = '0.0.0', budgetMs = 5000 }) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 5000) throw new Error('intent input invalid-budget');
  const started = performance.now();
  const request = intentInputRequest({ command, values, suppliedOptions, files });
  if (!request) throw new Error('intent input requires an explicit mode');
  const remaining = Math.floor(budgetMs - (performance.now() - started));
  if (remaining < 1) throw new Error('intent input deadline');
  let input;
  if (request.kind === 'document') {
    const admitted = admitIntentDocument({ projectDir, file: request.file });
    input = { kind: 'document', file: admitted.file, hash: admitted.hash, bytes: admitted.identity.size };
  } else {
    input = { kind: 'fix', ...readScopedFixCommitInventory({ projectDir, commit: request.commit, budgetMs: remaining }) };
  }
  const doc = { schemaVersion: 1, tool: { name: 'testguard', version: toolVersion }, purpose: 'authoring-input', verification: 'not-performed', next: 'supply-independent-intent', input };
  let output;
  writeSpecDoc('authoring-input', 'read-only input preview', doc, { publish: bytes => {
    if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('intent input output byte limit exceeded');
    output = bytes;
  } });
  if (performance.now() - started >= budgetMs) throw new Error('intent input deadline');
  return freezeOwned({ doc, output });
}
