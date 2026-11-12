#!/usr/bin/env node
/**
 * Builds a subject's `claims.json` from exactly two inputs, so a reviewer can
 * see that nothing else shaped it:
 *
 *   provenance/claims.author.json  the blind claim author's output, verbatim
 *   provenance/defenders.json      the requirement → test-file rule, fixed
 *                                  before the claim and test authors ran
 *
 * The only additions are the fields the claims schema requires and the author
 * could not know (source, producedBy, defendedBy). `--check` fails when the
 * committed claims.json differs from what these inputs produce.
 *
 * usage: node corpus/assemble.mjs <subject-dir>... [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export const CLAIM_AUTHOR = 'corpus claim author (claude-sonnet-5-5, blind to the tests)';

export function assemble(subjectDir) {
  const subject = basename(resolve(subjectDir));
  const authored = JSON.parse(readFileSync(join(subjectDir, 'provenance', 'claims.author.json'), 'utf8'));
  const { byRequirement } = JSON.parse(readFileSync(join(subjectDir, 'provenance', 'defenders.json'), 'utf8'));
  const claims = authored.map((c) => {
    if (!(c.requirement in byRequirement)) throw new Error(`${subject}: claim ${c.id} names ${c.requirement}, which the defender rule does not map`);
    const defenders = byRequirement[c.requirement];
    const claim = {
      id: c.id,
      statement: c.statement,
      source: { kind: 'spec', ref: `req:${subject}#${c.requirement}` },
      severity: c.severity,
      producedBy: { producer: 'agent', by: CLAIM_AUTHOR },
    };
    if (defenders) claim.defendedBy = defenders;
    claim.faults = c.faults.map((f) => {
      const fault = { id: f.id, description: f.description, faultClass: f.faultClass, file: f.file, find: f.find, replace: f.replace };
      if (f.expectHits !== undefined) fault.expectHits = f.expectHits;
      fault.producedBy = { producer: 'agent', by: CLAIM_AUTHOR };
      return fault;
    });
    return claim;
  });
  return `${JSON.stringify({ schemaVersion: 1, claims }, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  let failed = false;
  for (const dir of args.filter((a) => a !== '--check')) {
    const text = assemble(dir);
    const target = join(dir, 'claims.json');
    if (check) {
      let current = '';
      try { current = readFileSync(target, 'utf8'); } catch {}
      if (current !== text) { console.error(`${target}: differs from what provenance/ produces`); failed = true; }
    } else {
      writeFileSync(target, text);
      console.log(`wrote ${target}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
