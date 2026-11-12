// The brief carries the status document's speed advice (issue #270): the
// session-start context says how to go faster, one line each with the command.
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildBrief, renderBriefMarkdown } from '../src/brief/brief.mjs';
import { validate } from '../spec/lib/validate.mjs';

const evidence = JSON.parse(readFileSync(new URL('../spec/conformance/examples/evidence.json', import.meta.url), 'utf8'));
const advice = [{ id: 'serial-on-multicore', message: 'The last probe ran with --serial on a machine with 8 CPUs; without it, 4 faults run at once and every kill is still confirmed alone.', command: 'testguard probe' }];

it('says how to go faster, with the command, and conforms', () => {
  const brief = buildBrief(evidence, undefined, { advice });
  expect(brief.advice).toEqual(advice);
  expect(brief.text).toContain('SPEED: The last probe ran with --serial on a machine with 8 CPUs; without it, 4 faults run at once and every kill is still confirmed alone. → testguard probe');
  expect(validate('brief', brief).errors).toEqual([]);
  expect(renderBriefMarkdown(brief, { total: evidence.records.length })).toContain('### Go faster');
});

it('no advice, no section', () => {
  const brief = buildBrief(evidence, undefined, {});
  expect(brief.advice).toBeUndefined();
  expect(brief.text).not.toContain('SPEED:');
});
