// #301: testguard.config.json and `probe --changed --explain` through the CLI,
// without a measurement: what status and probe report, what is refused, and
// that --explain probes nothing. The measured runs are in
// project-config-probe.test.mjs; the rules in project-config.test.mjs.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { CONFIG_FILE } from '../src/config/project-config.mjs';
import { commit, project } from './helpers/scope-project.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const repo = () => { const p = project(); roots.push(p.root); return p; };
const writeConfig = (dir, config) => writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ schemaVersion: 1, ...config }));
const run = async (args) => {
  const out = [];
  const err = [];
  const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

describe('testguard.config.json through the CLI', () => {
  it('status reports the file; an unknown key is a usage error naming it; --no-config ignores the file', async () => {
    const p = repo();
    writeConfig(p.dir, { runner: 'node-test', python: 'python3' });
    const status = JSON.parse((await run(['status', p.dir, '--json'])).out);
    expect(validate('status', status).errors).toEqual([]);
    expect(status.config).toMatchObject({ file: CONFIG_FILE, keys: ['runner', 'python'] });
    expect(JSON.parse((await run(['status', p.dir, '--json', '--no-config'])).out).config).toBeUndefined();
    expect((await run(['status', p.dir])).out).toContain(`config: ${CONFIG_FILE} sets runner, python`);

    writeConfig(p.dir, { runner: 'node-test', confirmRuns: 3 });
    const bad = await run(['probe', p.dir]);
    expect(bad.code).toBe(3);
    expect(bad.err).toContain('unknown key "confirmRuns"');
    expect((await run(['status', p.dir, '--no-config'])).code).not.toBe(3);
    expect((await run(['gate', p.dir, '--no-config'])).code).toBe(3);
  });
});

describe('probe --changed <ref> --explain', () => {
  it('names each selected claim and why, probes and writes nothing, and exits 0', async () => {
    const p = repo();
    writeConfig(p.dir, { runner: 'node-test' });
    commit(p.dir);
    const text = await run(['probe', p.dir, '--changed', p.base, '--explain']);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/2 of 2 claims selected/);
    expect(text.out).toMatch(/PRICE-TOTAL\s+file testguard\.config\.json/);
    expect(text.out).toContain('by reason: file 2, glob 0, discovery 0, indeterminate 0');
    const json = await run(['probe', p.dir, '--changed', p.base, '--explain', '--json']);
    const doc = JSON.parse(json.out);
    expect(validate('status', doc).errors).toEqual([]);
    expect(doc.run).toMatchObject({ exitCode: 0, config: { file: CONFIG_FILE, keys: ['runner'] }, scope: { explain: true, probedClaims: [], probedCount: 0, selectedCount: 2 } });
    expect(doc.run.id).toBeUndefined();
    expect(existsSync(join(p.dir, '.testguard'))).toBe(false);
  });

  it('needs --changed, and an undetermined change still exits 2', async () => {
    const p = repo();
    expect((await run(['probe', p.dir, '--explain'])).code).toBe(3);
    expect((await run(['probe', p.dir, '--changed', 'no-such-ref', '--explain'])).code).toBe(2);
  });
});
