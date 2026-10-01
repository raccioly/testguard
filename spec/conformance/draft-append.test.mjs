import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { appendDraft } from '../../src/scaffold/append.mjs';
import { writeSpecDoc } from '../../src/evidence/writer.mjs';
import { validate } from '../lib/validate.mjs';

describe('draft append uses the existing claims contract, never evidence', () => {
  it('publishes a complete conforming claims document without replacing supplied intent', () => {
    const draft = JSON.parse(readFileSync(new URL('./examples/claims.json', import.meta.url)));
    const proposals = structuredClone(draft); proposals.claims = [proposals.claims[0]];
    proposals.claims[0].faults = [{ ...proposals.claims[0].faults[0], file: 'src/append-new.mjs' }];
    const merged = appendDraft({ draft, proposals, claimId: draft.claims[0].id }); let output;
    writeSpecDoc('claims', 'not-written.json', merged, { publish: bytes => { output = JSON.parse(bytes); } });
    expect(validate('claims', output).ok).toBe(true); expect(validate('evidence', output).ok).toBe(false);
    expect(output.claims[0].statement).toBe(draft.claims[0].statement); expect(output.claims[0].source).toEqual(draft.claims[0].source);
    expect(output.claims[0].faults.slice(0, draft.claims[0].faults.length)).toEqual(draft.claims[0].faults);
  });
});
