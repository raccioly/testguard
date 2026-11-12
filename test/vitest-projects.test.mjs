// @req FR-10
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
//
// Vitest `test.projects` (#277): `vitest list` names the project of every file,
// and a defender runs under each project that lists it, selected with
// `--project`, never by its file path alone.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDiscoveryManifest, normalizeDiscoveredEntries } from '../src/probe/runners/discovery.mjs';
import { hashNativeTestUniverse } from '../src/probe/universe.mjs';
import * as vitest from '../src/probe/runners/vitest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = join(ROOT, 'test', 'samples', 'vitest-list');
const dirs = [];
const scratch = (prefix = 'testguard-vitest-projects-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const write = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

// Recorded `vitest list --filesOnly` output (text and `--json=<file>`) of
// vitest 3.2.7, 4.1.12 and 5.1.0 over one layout: tests/ui/a (ui only),
// tests/node/b (node only), tests/shared/both (both projects). `unnamed`
// leaves the first project without a name, which vitest lists as "0".
const EXPECTED = {
  plain: [['tests/node/b.test.mjs', null], ['tests/shared/both.test.mjs', null], ['tests/ui/a.test.mjs', null]],
  projects: [['tests/node/b.test.mjs', 'node'], ['tests/shared/both.test.mjs', 'node'], ['tests/shared/both.test.mjs', 'ui'], ['tests/ui/a.test.mjs', 'ui']],
  unnamed: [['tests/node/b.test.mjs', 'node'], ['tests/ui/a.test.mjs', '0']],
};
const pairs = (entries) => entries.map(({ file, project }) => [file.replace(/^<root>\//, ''), project ?? null])
  .sort((a, b) => `${a[0]}\0${a[1]}`.localeCompare(`${b[0]}\0${b[1]}`));

describe('reading vitest list output, recorded from vitest 3, 4 and 5', () => {
  const samples = readdirSync(SAMPLES).filter((name) => name.endsWith('.txt'));
  it('has a recording for every version, layout and form', () => {
    expect(samples.length).toBe(9);
    for (const sample of samples) expect(readdirSync(SAMPLES)).toContain(sample.replace(/\.txt$/, '.json'));
  });

  for (const sample of samples) {
    const layout = sample.replace(/^vitest-[\d.]+-/, '').replace(/\.txt$/, '');
    it(`${sample}: the text and JSON forms both give each file with its project`, () => {
      const text = readFileSync(join(SAMPLES, sample), 'utf8');
      const json = JSON.parse(readFileSync(join(SAMPLES, sample.replace(/\.txt$/, '.json')), 'utf8'));
      expect(pairs(vitest.parseDiscoveryOutput(text))).toEqual(EXPECTED[layout]);
      expect(pairs(vitest.parseDiscoveryReport(json))).toEqual(EXPECTED[layout]);
    });
  }

  it('keeps a whole line that names an existing file, such as a [slug] directory', () => {
    // `[slug]/x` never looks like a prefix; `[draft] notes.test.mjs` does, and
    // is still the file of that name when one exists.
    const exists = (path) => path === '[draft] notes.test.mjs';
    expect(vitest.parseDiscoveryOutput('[slug]/page.test.mjs\n[draft] notes.test.mjs\n[ui] tests/a.test.mjs\n', exists)).toEqual([
      { file: '[slug]/page.test.mjs' },
      { file: '[draft] notes.test.mjs' },
      { file: 'tests/a.test.mjs', project: 'ui' },
    ]);
  });

  it('refuses a report that is not a list of files', () => {
    expect(() => vitest.parseDiscoveryReport({ files: [] })).toThrow(/array/);
    expect(() => vitest.parseDiscoveryReport([{ name: 'x' }])).toThrow(/file/);
  });
});

describe('project membership in the test universe', () => {
  it('binds membership into the hash, and leaves a universe without projects unchanged', () => {
    const files = ['tests/a.test.mjs', 'tests/b.test.mjs'];
    const plain = createDiscoveryManifest({ runner: 'vitest', version: '5.0.0', files });
    const withProjects = createDiscoveryManifest({ runner: 'vitest', version: '5.0.0', files, projects: { 'tests/a.test.mjs': ['ui'], 'tests/b.test.mjs': ['node', 'ui'] } });
    const moved = createDiscoveryManifest({ runner: 'vitest', version: '5.0.0', files, projects: { 'tests/a.test.mjs': ['ui'], 'tests/b.test.mjs': ['node'] } });
    expect(plain).not.toHaveProperty('projects');
    expect(plain.testUniverseHash).toBe(createDiscoveryManifest({ runner: 'vitest', version: '5.0.0', files, projects: {} }).testUniverseHash);
    expect(withProjects.testUniverseHash).not.toBe(plain.testUniverseHash);
    expect(moved.testUniverseHash).not.toBe(withProjects.testUniverseHash);
    expect(() => createDiscoveryManifest({ runner: 'vitest', version: '5.0.0', files, projects: { 'tests/z.test.mjs': ['ui'] } })).toThrow(/project/);
  });

  it('rebuilds a manifest with projects to the same hash when the universe is bound', () => {
    const manifest = createDiscoveryManifest({ runner: 'vitest', version: '5.0.0', files: ['tests/a.test.mjs'], projects: { 'tests/a.test.mjs': ['ui'] } });
    expect(() => hashNativeTestUniverse(new Map([[{ name: 'vitest' }, manifest]]))).not.toThrow();
  });

  it('normalizes entries to project-relative files with their sorted projects', () => {
    const dir = scratch();
    write(dir, 'tests/a.test.mjs', '');
    write(dir, 'tests/b.test.mjs', '');
    const { files, projects } = normalizeDiscoveredEntries(dir, [
      { file: join(dir, 'tests/b.test.mjs'), project: 'ui' },
      { file: 'tests/b.test.mjs', project: 'node' },
      { file: 'tests/a.test.mjs' },
    ]);
    expect(files).toEqual(['tests/a.test.mjs', 'tests/b.test.mjs']);
    expect(projects).toEqual({ 'tests/b.test.mjs': ['node', 'ui'] });
  });
});

describe('running a defender under the projects that list it', () => {
  it('runs one invocation per project, each selected with --project', () => {
    const groups = vitest.projectRuns(['tests/a.test.mjs', 'tests/both.test.mjs', 'tests/plain.test.mjs'], {
      'tests/a.test.mjs': ['ui'],
      'tests/both.test.mjs': ['node', 'ui'],
    });
    expect(groups).toEqual([
      { project: null, files: ['tests/plain.test.mjs'] },
      { project: 'node', selector: 'node', files: ['tests/both.test.mjs'] },
      { project: 'ui', selector: 'ui', files: ['tests/a.test.mjs', 'tests/both.test.mjs'] },
    ]);
    expect(vitest.argvFor(ROOT, ['tests/a.test.mjs'], '/tmp/out.json', { project: 'ui' })).toContain('--project=ui');
    expect(vitest.argvFor(ROOT, ['tests/a.test.mjs'], '/tmp/out.json').some((arg) => arg.startsWith('--project'))).toBe(false);
  });

  it('selects a name vitest would read as a number or a negation by an exact pattern, and refuses an ambiguous one', () => {
    expect(vitest.projectSelector('0', ['0', 'node'])).toBe('0*');
    expect(vitest.projectSelector('!odd', ['!odd', 'node'])).toBe('*!odd');
    expect(() => vitest.projectSelector('0', ['0', '01'])).toThrow(/project "0".*cannot be selected/);
    // vitest matches project names case-insensitively.
    expect(() => vitest.projectSelector('ui', ['ui', 'UI'])).toThrow(/project "ui".*cannot be selected/);
  });

});
