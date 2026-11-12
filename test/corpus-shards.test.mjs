// #305: the corpus runs as one shard per subject, per mutant group and, for the Playwright gallery, per mode.
// corpus/shards.json is the one list: the workflow's matrix and its scorecard's expected-shard check both read it.
// Nothing may be dropped by the split: every subject, every mode and every mutant is in exactly one shard.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODES, applies } from '../corpus/lib/modes.mjs';
import { listSubjects, loadSubject, subjectRef } from '../corpus/lib/subject.mjs';
import { parseYaml } from './helpers/yaml.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { shards } = JSON.parse(readFileSync(join(ROOT, 'corpus', 'shards.json'), 'utf8'));
const workflow = parseYaml(join(ROOT, '.github', 'workflows', 'corpus.yml'))[0];
const values = (flag) => shards.flatMap((s) => [...s.args.matchAll(new RegExp(`${flag} (\\S+)`, 'g'))].map((m) => m[1]));
const GALLERY = shards.filter((s) => s.args.includes('--subject js-playwright-gallery'));

describe('corpus shards', () => {
  it('names are unique and every shard has a measured-looking timeout in minutes', () => {
    expect(new Set(shards.map((s) => s.name)).size).toBe(shards.length);
    for (const s of shards) { expect(Number.isInteger(s.timeout), s.name).toBe(true); expect(s.timeout, s.name).toBeGreaterThan(0); expect(s.timeout, s.name).toBeLessThanOrEqual(40); }
  });

  it('every subject (and variant) is in exactly one shard, except the gallery, whose modes are split across shards', () => {
    const named = values('--subject');
    for (const subject of listSubjects().filter((n) => n !== 'js-playwright-gallery')) expect(shards.filter((x) => x.args.includes(`--subject ${subject}`)).length, subject).toBe(1);
    expect([...new Set(named)].sort()).toEqual(listSubjects().sort());
  });

  it('every mode that applies to the gallery has a shard, the reference has its own, and none is spent on a mode that does not apply', () => {
    const { dir } = subjectRef('js-playwright-gallery');
    const subject = loadSubject(dir, {});
    const modeOf = (s) => [...s.args.matchAll(/--mode (\S+)/g)].map((m) => m[1]);
    const modes = GALLERY.flatMap(modeOf);
    expect([...new Set(modes)].sort()).toEqual(MODES.filter((m) => applies(m, subject)).sort());
    for (const s of GALLERY) {
      expect(modeOf(s).length, s.name).toBe(1);
      // every shard but the reference's takes the reference from the reference job
      expect(s.args.includes('--reference-later'), s.name).toBe(modeOf(s)[0] !== 'reference');
    }
    // `twice` runs as two claim halves, one shard each; every other mode once
    for (const m of new Set(modes)) expect(modes.filter((x) => x === m).length, m).toBe(m === 'twice' ? 2 : 1);
    expect(GALLERY.filter((s) => modeOf(s)[0] === 'twice').map((s) => /--slice (\d+\/\d+)/.exec(s.args)?.[1]).sort()).toEqual(['1/2', '2/2']);
  });

  it('every tool mutant is in exactly one shard', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'corpus', 'tool-mutants', 'manifest.json'), 'utf8')).mutants;
    const ids = manifest.map((m) => m.name);
    expect([...values('--mutant')].sort()).toEqual([...ids].sort());
  });
});

describe('corpus.yml builds its matrix and its expected-shard check from corpus/shards.json', () => {
  it('has no hand-kept shard list: the matrix comes from the plan job, the scorecard checks the plan against the artifacts', () => {
    expect(workflow.jobs.shard.strategy.matrix).toBe('${{ fromJSON(needs.plan.outputs.matrix) }}');
    expect(workflow.jobs.shard['timeout-minutes']).toBe('${{ matrix.timeout }}');
    expect(workflow.jobs.shard.needs).toBe('plan');
    expect(workflow.jobs.scorecard.needs).toEqual(['plan', 'shard']);
    const plan = workflow.jobs.plan.steps.find((s) => s.id === 'plan').run;
    expect(plan).toContain('corpus/shards.json');
    expect(workflow.jobs.scorecard.steps.find((s) => s.name === 'Merge, compare and publish').run).toContain('--complete');
    const check = workflow.jobs.scorecard.steps.find((s) => s.name === 'Every planned shard delivered its scorecard');
    expect(check.env.NAMES).toBe('${{ needs.plan.outputs.names }}');
    expect(check.run).toContain('missing shard scorecard');
    const order = workflow.jobs.scorecard.steps.map((s) => s.name);
    expect(order.indexOf('Every planned shard delivered its scorecard')).toBeLessThan(order.indexOf('Merge, compare and publish'));
  });

  it('does not add path filters beyond the ones it had', () => {
    const on = workflow.on ?? workflow[true]; // `on:` parses as the boolean key true under YAML 1.1
    expect(on.pull_request.paths).toContain('corpus/**');
    expect(on.push.paths).toContain('.github/workflows/corpus.yml');
  });
});
