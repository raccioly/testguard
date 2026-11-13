// #301 item 2: only an AGENTS.md section that is byte-for-byte a template TestGuard
// shipped is TestGuard's to rewrite; the edited-section case lives in init-fast-path.test.mjs.
import { describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS_HISTORY, agentsBlock, initProject } from '../src/init/init.mjs';
import { agentsSectionHash } from '../src/init/managed.mjs';
import { V, hermeticRepos, read, repo } from './helpers/owned-repo.mjs';

const made = hermeticRepos();

describe('which AGENTS.md sections are TestGuard\'s to rewrite (#301)', () => {
  it('every template this release writes is listed as unmodified, project bullets aside', () => {
    expect(AGENTS_HISTORY).toContain(agentsSectionHash(agentsBlock(['.'])));
    expect(agentsSectionHash(agentsBlock(['.']))).toBe(agentsSectionHash(agentsBlock(['.', 'api', 'web'])));
    expect(agentsSectionHash(agentsBlock(['.']).replace('Slow?', 'Fast?'))).not.toBe(agentsSectionHash(agentsBlock(['.'])));
  });

  it('a current section is not "edited": init lists a second project in it without losing it', () => {
    const dir = repo(made);
    initProject({ projectDir: dir, toolVersion: V });
    mkdirSync(join(dir, 'api'));
    initProject({ projectDir: join(dir, 'api'), toolVersion: V });
    expect(read(dir, 'AGENTS.md')).toContain('- `api/`: claims in `api/testguard.claims.json`');
  });
});

