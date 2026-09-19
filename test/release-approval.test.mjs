import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('..', import.meta.url).pathname;
const SCRIPT = join(ROOT, '.github', 'scripts', 'approve-held-runs.sh');

const run = (scenario) => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-held-runs-'));
  const state = join(dir, 'state');
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/bin/sh
set -eu
case "$*" in
  *'/approve'*)
    printf 'approved\\n' >> "$FAKE_GH_STATE"
    [ "$FAKE_GH_SCENARIO" != 'stuck' ]
    ;;
  *'.html_url'*)
    if [ "$FAKE_GH_SCENARIO" = 'stuck' ]; then
      printf 'https://github.example/runs/42\\n'
    fi
    ;;
  *'.id'*)
    if [ "$FAKE_GH_SCENARIO" = 'query-error' ]; then exit 2; fi
    if [ "$FAKE_GH_SCENARIO" = 'stuck' ] || { [ "$FAKE_GH_SCENARIO" = 'held-clears' ] && [ ! -s "$FAKE_GH_STATE" ]; }; then
      printf '42\\n'
    fi
    ;;
  *) exit 64 ;;
esac
`);
  chmodSync(gh, 0o755);
  const result = spawnSync('/bin/bash', [SCRIPT, 'abc1234', 'https://github.example/pull/7'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:/usr/bin:/bin`,
      GITHUB_REPOSITORY: 'owner/repo',
      FAKE_GH_SCENARIO: scenario,
      FAKE_GH_STATE: state,
      TESTGUARD_HELD_RUN_POLL_SECONDS: '0',
    },
  });
  return { ...result, approvals: readFileSync(state, { encoding: 'utf8', flag: 'a+' }) };
};

describe('release workflow approval holds', () => {
  it('both bot-created PR paths invoke the same approval helper', () => {
    for (const workflow of ['scheduled-release.yml', 'release.yml']) {
      const text = readFileSync(join(ROOT, '.github', 'workflows', workflow), 'utf8');
      expect(text).toContain('.github/scripts/approve-held-runs.sh "$HEAD_SHA" "$PR"');
    }
  });

  it('approves a held run and verifies that the hold cleared', () => {
    const result = run('held-clears');
    expect(result.status, result.stderr).toBe(0);
    expect(result.approvals).toBe('approved\n');
    expect(result.stdout).toMatch(/approved run 42/);
    expect(result.stdout).toMatch(/no run is held for approval/);
  });

  it('fails closed when GitHub cannot report the approval state', () => {
    const result = run('query-error');
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/Could not inspect workflow approval holds/);
  });

  it('fails with the held run URL when approval never clears', () => {
    const result = run('stuck');
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/will wait forever/);
    expect(result.stdout).toMatch(/https:\/\/github\.example\/runs\/42/);
  });
});
