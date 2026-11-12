// #305: the corpus runs as one shard per subject, per mutant group and, for the Playwright gallery, per mode.
// corpus/shards.json is the one list: the workflow's matrix and its scorecard's expected-shard check both read it.
// Nothing may be dropped by the split: every subject, every mode and every mutant is in exactly one shard.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODES } from '../corpus/lib/modes.mjs';
import { listSubjects } from '../corpus/lib/subject.mjs';
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

  it('every mode of the Playwright gallery runs in exactly one shard, one mode (or only no-op ones) per shard', () => {
    const modes = GALLERY.flatMap((s) => [...s.args.matchAll(/--mode (\S+)/g)].map((m) => m[1]));
    expect([...modes].sort()).toEqual(MODES.filter((m) => m !== 'reference').sort());
    for (const s of GALLERY) {
      const own = [...s.args.matchAll(/--mode (\S+)/g)].map((m) => m[1]);
      expect(own.filter((m) => !['partial', 'typecheck', 'changed'].includes(m)).length, s.name).toBeLessThanOrEqual(1);
    }
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
