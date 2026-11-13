// #301: testguard.config.json through measured probes. Few and run once each
// (--confirm 1): they prove what a caller sees end to end, while
// project-config-reuse.test.mjs holds the reuse rule at unit level.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('testguard.config.json through measured probes', () => {
  it('a flag moved into the committed file carries every verdict; an uncommitted file is refused like a dirty defender', async () => {
    const p = repo();
    const first = await run(['probe', p.dir, '--runner', 'node-test', '--confirm', '1', '--json']);
    expect(first.code).toBe(0);
    const records = JSON.parse(first.out).run.records;
    expect(records).toBeGreaterThan(0);

    writeConfig(p.dir, { runner: 'node-test', confirm: 1 });
    const dirty = await run(['probe', p.dir]);
    expect(dirty.code).toBe(2);
    expect(dirty.err).toContain(CONFIG_FILE);
    // --ignore-dirty proceeds and says the working-tree copy IS applied; it is not an ignored file.
    const ignoring = await run(['probe', p.dir, '--ignore-dirty', '--json']);
    expect(ignoring.code).toBe(0);
    expect(ignoring.err).toContain(`${CONFIG_FILE} has uncommitted changes; its working-tree version sets how the tests run`);
    const evidence = JSON.parse(readFileSync(JSON.parse(ignoring.out).run.evidence, 'utf8'));
    expect(evidence.run.repo.ignoredDirty).toBeUndefined();

    commit(p.dir);
    const second = await run(['probe', p.dir, '--json']);
    expect(second.code).toBe(0);
    const doc = JSON.parse(second.out);
    expect(validate('status', doc).errors).toEqual([]);
    expect(doc.run.reuse).toEqual({ reused: records, measured: 0 });
    expect(doc.run.config).toMatchObject({ file: CONFIG_FILE, keys: ['runner', 'confirm'] });
    expect(second.err).toContain(`from "confirm" in ${CONFIG_FILE}`);

    // The same option changed in the file refuses reuse, as the flag would.
    writeConfig(p.dir, { runner: 'node-test', confirm: 1, workers: 2 });
    commit(p.dir);
    const third = JSON.parse((await run(['probe', p.dir, '--json'])).out);
    expect(third.run.reuse).toEqual({ reused: 0, measured: records });
  }, 60_000);
});
