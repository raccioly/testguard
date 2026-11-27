// The pure parts of the karma adapter (#329): finding Karma in a project, which
// Angular project a spec belongs to, the command line, the generated Karma
// config, and what the refusal says when `auto` found nothing but a build system.
// Reads a few small files; starts no process.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectKarma, angularProjectFor, karmaConfigFor, ngArgv, karmaWrapperSource, firstNgError } from '../src/probe/runners/karma.mjs';
import { runnerUnresolvableMessage, detectBuildRunners } from '../src/probe/runners/index.mjs';

let dir;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-karma-pure-'))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const put = (rel, text = '') => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
const angularJson = (builder = '@angular-devkit/build-angular:karma') => JSON.stringify({
  version: 1,
  projects: { app: { root: '', sourceRoot: 'src', architect: { test: { builder, options: {} } } } },
});

describe('detectKarma: found from the files, started from nothing', () => {
  it('finds a karma builder in angular.json, old and new builder names', () => {
    put('angular.json', angularJson('@angular-devkit/build-angular:karma'));
    expect(detectKarma(dir)).toMatchObject({ found: true, why: expect.stringContaining('angular.json') });
    put('angular.json', angularJson('@angular/build:karma'));
    expect(detectKarma(dir).found).toBe(true);
  });

  it('finds karma in package.json dependencies', () => {
    put('package.json', JSON.stringify({ devDependencies: { karma: '^6.4.0', 'karma-jasmine': '^5.1.0' } }));
    expect(detectKarma(dir)).toMatchObject({ found: true, why: expect.stringContaining('package.json') });
  });

  it('finds nothing in a project with a different test builder, or neither file', () => {
    expect(detectKarma(dir)).toBeNull();
    put('angular.json', angularJson('@angular-devkit/build-angular:jest'));
    put('package.json', JSON.stringify({ devDependencies: { vitest: '^2' } }));
    expect(detectKarma(dir)).toBeNull();
  });

  it('survives an angular.json it cannot parse', () => {
    put('angular.json', '{ not json');
    expect(detectKarma(dir)).toBeNull();
  });

  it('is part of detectBuildRunners, with Maven and Gradle', () => {
    put('angular.json', angularJson()); put('pom.xml'); put('build.gradle');
    expect(detectBuildRunners(dir).map((d) => d.runner)).toEqual(['maven', 'gradle', 'karma']);
  });
});


describe('the refusal when auto found a build system', () => {
  const tried = 'vitest: vitest is not installed in the project and `vitest` is not on PATH (npm i -D vitest)';

  it('leads with what was found and the flag, and does not tell you to install dependencies first', () => {
    const sel = { error: `Karma was found (angular.json has a karma test builder), but TestGuard does not choose it on its own: run it with --runner karma. Runners \`auto\` tried: ${tried}`, detected: [{ runner: 'karma', why: 'angular.json has a karma test builder' }] };
    const message = runnerUnresolvableMessage({ sel, mode: 'in-place' });
    expect(message).toMatch(/^test runner is not resolvable in the project \(Karma was found/);
    expect(message).not.toMatch(/If dependencies are missing, install them first/);
    expect(runnerUnresolvableMessage({ sel, mode: 'worktree' })).toContain('scratch worktree');
  });

  it('a refusal with nothing detected keeps its install advice', () => {
    expect(runnerUnresolvableMessage({ sel: { error: tried }, mode: 'in-place' })).toContain('If dependencies are missing, install them first');
    expect(runnerUnresolvableMessage({ sel: { error: tried }, mode: 'worktree' })).toContain('--node-modules');
  });

  it('a config error still gets only its own message', () => {
    expect(runnerUnresolvableMessage({ sel: { error: 'bad tsconfig', configError: true }, mode: 'in-place' })).toMatch(/Fix that config file/);
  });
});

describe('pure parts', () => {
  const doc = JSON.parse(JSON.stringify({
    projects: {
      web: { root: '', sourceRoot: 'src', architect: { test: { builder: '@angular/build:karma', options: { karmaConfig: 'karma.web.js' } } } },
      lib: { root: 'projects/lib', architect: { test: { builder: '@angular-devkit/build-angular:karma' } } },
      e2e: { root: 'projects/e2e', architect: { test: { builder: '@angular-devkit/build-angular:jest' } } },
    },
  }));

  it('angularProjectFor: the project with the longest root that holds the file and a karma test target', () => {
    expect(angularProjectFor(doc, 'projects/lib/src/a.spec.ts')).toBe('lib');
    expect(angularProjectFor(doc, 'src/app/b.spec.ts')).toBe('web');
    expect(angularProjectFor(doc, 'projects/e2e/src/c.spec.ts')).toBe('web');
    expect(angularProjectFor({ projects: { x: { root: 'x', architect: { test: { builder: 'jest' } } } } }, 'x/a.spec.ts')).toBeNull();
    expect(angularProjectFor({}, 'a.spec.ts')).toBeNull();
  });

  it('karmaConfigFor: the project\'s own option, then karma.conf.js in its root', () => {
    expect(karmaConfigFor(doc, 'web', () => true)).toBe('karma.web.js');
    expect(karmaConfigFor(doc, 'lib', (p) => p === 'projects/lib/karma.conf.js')).toBe('projects/lib/karma.conf.js');
    expect(karmaConfigFor(doc, 'lib', () => false)).toBeNull();
  });

  it('ngArgv: no watch, headless, the generated config, one include per file', () => {
    expect(ngArgv({ ng: ['node', '/p/ng.js'], project: 'web', config: '/s/k.cjs', files: ['src/a.spec.ts', 'src/b.spec.ts'] })).toEqual([
      'node', '/p/ng.js', 'test', 'web', '--watch=false', '--browsers=ChromeHeadless', '--karma-config=/s/k.cjs', '--include=src/a.spec.ts', '--include=src/b.spec.ts',
    ]);
  });

  it('firstNgError: the TypeScript line, then the first error', () => {
    expect(firstNgError('\u001b[31mError\u001b[0m: src/app/price.ts:5:3 - error TS1005: ; expected.\nmore')).toBe('Error: src/app/price.ts:5:3 - error TS1005: ; expected.');
    expect(firstNgError('x\nError: boom\n')).toBe('Error: boom');
    expect(firstNgError('fine')).toBeNull();
  });

  it('the generated config loads the project\'s config first, then forces the reporter and the directory', () => {
    const source = karmaWrapperSource({ projectDir: '/proj', base: '/proj/karma.conf.js', outDir: '/scratch/out' });
    expect(source).toContain('"/proj/karma.conf.js"');
    expect(source).toContain('"/scratch/out"');
    expect(source).toMatch(/reporters: \['junit'\]/);
    expect(source).toContain('singleRun: true');
    expect(source.indexOf('base(config)')).toBeGreaterThan(-1);
    expect(source.indexOf('base(config)')).toBeLessThan(source.indexOf('config.set'));
  });
});

