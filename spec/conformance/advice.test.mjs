// `status.advice[]` (issue #270): where a run leaves speed on the table, one
// line each with the command to run. Informational and closed.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../lib/validate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const load = (dir, file) => JSON.parse(readFileSync(join(here, dir, file), 'utf8'));
const paths = (doc) => validate('status', doc).errors.map((e) => e.path);

describe('status advice', () => {
  it('a status with advice lines conforms', () => {
    const doc = load('examples', 'status-advice.json');
    expect(doc.advice.map((a) => a.id)).toEqual(['serial-on-multicore', 'slow-defenders-dominate', 'hook-outdated', 'orphaned-scratch']);
    expect(validate('status', doc).errors).toEqual([]);
  });

  it('the set of advice is closed', () => {
    expect(paths(load('invalid', 'status.advice-unknown-id.json'))).toContain('/advice/0/id');
  });

  it('every line names a TestGuard command, never anything else to run', () => {
    expect(paths(load('invalid', 'status.advice-not-a-testguard-command.json'))).toContain('/advice/0/command');
  });
});

describe('advice is the line its rule produces', () => {
  it('the slow-defender advice points at the per-claim cost report, nothing else (#291)', () => {
    expect(paths(load('invalid', 'status.advice-slow-defenders-wrong-command.json'))).toEqual(['/advice/0/command']);
  });

  it('the leftover-scratch advice points at testguard clean, nothing else (#311)', () => {
    expect(paths(load('invalid', 'status.advice-orphaned-scratch-wrong-command.json'))).toEqual(['/advice/0/command']);
  });

  it('the change-scoped probe is advised only where the next step is a probe', () => {
    expect(paths(load('invalid', 'status.advice-changed-without-a-probe-next.json'))).toEqual(['/advice/1/id']);
  });

  it('an outdated hook is fixed by init --upgrade, and the change-scoped advice names probe --changed', () => {
    const doc = load('examples', 'status-advice.json');
    doc.advice[2].command = 'testguard init';
    expect(paths(doc)).toEqual(['/advice/2/command']);
  });

  it('an inactive hook is fixed by init --activate-hook; any other command is still refused (#301)', () => {
    const doc = load('examples', 'status-advice.json');
    doc.advice[2].message = '.githooks/pre-push:1: is not on this clone\'s active hooks path, so it never runs on push — git config core.hooksPath .githooks; testguard init --activate-hook runs it';
    doc.advice[2].command = 'testguard init --activate-hook';
    expect(paths(doc)).toEqual([]);
    doc.advice[2].command = 'testguard init --force';
    expect(paths(doc)).toEqual(['/advice/2/command']);
  });

  it('a brief carries the same advice under the same rules', () => {
    const brief = load('examples', 'brief-advice.json');
    expect(validate('brief', brief).errors).toEqual([]);
    brief.advice[0].command = 'testguard probe';
    expect(validate('brief', brief).errors.map((e) => e.path)).toEqual(['/advice/0/command']);
    expect(validate('brief', load('invalid', 'brief.advice-said-twice.json')).errors.map((e) => e.path)).toEqual(['/advice/2/id']);
  });
});
