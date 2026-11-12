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
    expect(doc.advice.map((a) => a.id)).toEqual(['serial-on-multicore', 'full-probe-where-changed-would-do', 'hook-outdated']);
    expect(validate('status', doc).errors).toEqual([]);
  });

  it('the set of advice is closed', () => {
    expect(paths(load('invalid', 'status.advice-unknown-id.json'))).toContain('/advice/0/id');
  });

  it('every line names a TestGuard command, never anything else to run', () => {
    expect(paths(load('invalid', 'status.advice-not-a-testguard-command.json'))).toContain('/advice/0/command');
  });
});
