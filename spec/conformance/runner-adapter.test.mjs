// spec/RUNNER-ADAPTER.md (#329): every adapter the engine can select satisfies
// the published contract, the check can fail, and the document names exactly
// the exports the check reads.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RUNNERS, OWNED_RUNNERS } from '../../src/probe/runners/index.mjs';
import { SOURCE_EXT, KNOWN_SOURCE } from '../../src/gate/changed.mjs';
import { checkRunnerAdapter, ADAPTER_EXPORTS } from '../lib/runner-adapter.mjs';

const doc = readFileSync(fileURLToPath(new URL('../RUNNER-ADAPTER.md', import.meta.url)), 'utf8');
const paths = (adapter) => checkRunnerAdapter(adapter).map((e) => e.path);
const minimal = () => ({ name: 'example', check: async () => ({ ok: true }), run: async () => ({}), tests: () => [] });

describe('every adapter in RUNNERS satisfies the published contract', () => {
  for (const [key, adapter] of Object.entries(RUNNERS)) {
    it(key, () => {
      expect(checkRunnerAdapter(adapter)).toEqual([]);
    });
  }

  it('gives every adapter its own name, because the evidence records the name and reuse compares it', () => {
    const names = Object.values(RUNNERS).map((r) => r.name);
    // pytest and unittest are the python adapter with an engine pinned, under names of their own
    expect(new Set(names).size).toBe(names.length);
  });

  it('every owning adapter lists its files', () => {
    for (const adapter of OWNED_RUNNERS) expect(typeof adapter.tests).toBe('function');
  });
});

describe('the check can fail', () => {
  it('accepts the smallest adapter', () => {
    expect(checkRunnerAdapter(minimal())).toEqual([]);
  });

  it('names each required export that is missing', () => {
    expect(paths({})).toEqual(['name', 'check', 'run', 'tests']);
    for (const key of ['name', 'check', 'run']) {
      const adapter = minimal();
      delete adapter[key];
      expect(paths(adapter)).toEqual([key]);
    }
  });

  it('refuses an adapter with no way to name its test universe, and accepts discoverTests alone', () => {
    const adapter = minimal();
    delete adapter.tests;
    expect(paths(adapter)).toEqual(['tests']);
    adapter.discoverTests = async () => ({});
    expect(checkRunnerAdapter(adapter)).toEqual([]);
  });

  it('refuses the wrong type for an optional export', () => {
    for (const [key, value] of [['owns', 'yes'], ['fatalEdit', 1], ['parseReport', {}], ['testGlobs', '**/*.java'], ['testGlobs', [1]], ['sharedExternalState', 'true'], ['sharedExternalState', 1]]) {
      expect(paths({ ...minimal(), [key]: value }), `${key}=${JSON.stringify(value)}`).toContain(key);
    }
  });

  it('owns without tests is refused', () => {
    const adapter = { ...minimal(), owns: () => true, discoverTests: async () => ({}) };
    delete adapter.tests;
    expect(paths(adapter)).toEqual(['owns']);
  });

  it('refuses a name the evidence cannot record', () => {
    for (const name of ['Maven', 'java 21', '', '1gradle', undefined]) expect(paths({ ...minimal(), name })).toEqual(['name']);
  });

  it('refuses extensions that are not extensions', () => {
    for (const extensions of [[], 'java', ['java'], ['.Java'], ['.java', '.java'], [''], [1]]) {
      expect(paths({ ...minimal(), extensions }), JSON.stringify(extensions)).toEqual(['extensions']);
    }
    expect(checkRunnerAdapter({ ...minimal(), extensions: ['.java', '.kt'] })).toEqual([]);
  });

  it('refuses a fatalEdit that returns nothing parseable as text, or throws', () => {
    expect(paths({ ...minimal(), fatalEdit: () => '' })).toEqual(['fatalEdit']);
    expect(paths({ ...minimal(), fatalEdit: () => 42 })).toEqual(['fatalEdit']);
    expect(paths({ ...minimal(), fatalEdit: () => { throw new Error('no'); } })).toEqual(['fatalEdit']);
    expect(checkRunnerAdapter({ ...minimal(), fatalEdit: () => '<broken' })).toEqual([]);
  });

  it('refuses a value that is not an adapter at all', () => {
    expect(checkRunnerAdapter(null)).toHaveLength(1);
    expect(checkRunnerAdapter('vitest')).toHaveLength(1);
  });
});

describe('extensions and the gate', () => {
  it('every extension an adapter declares is one the gate already treats as source', () => {
    for (const adapter of Object.values(RUNNERS)) for (const ext of adapter.extensions ?? []) expect(SOURCE_EXT.has(ext), `${adapter.name} ${ext}`).toBe(true);
  });

  it('a language the gate still lists as unprobeable is declared by no adapter', () => {
    const declared = new Set(Object.values(RUNNERS).flatMap((r) => r.extensions ?? []));
    for (const language of KNOWN_SOURCE) for (const ext of declared) expect(language.match(`src/file${ext}`), `${language.id} ${ext}`).toBe(false);
  });
});

describe('the document and the check agree', () => {
  it('names every export the check reads, in a table row of its own', () => {
    for (const key of Object.keys(ADAPTER_EXPORTS)) expect(doc, key).toMatch(new RegExp(`^\\| \`${key}\``, 'm'));
  });
});
