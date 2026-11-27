import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { scratchRoot } from '../../scratch-dir.mjs';
import { parseJsonc } from '../../util/jsonc.mjs';
import { JS_EXTENSIONS, resolveRunner, listTestFiles, runProcess, mergeRuns } from './shared.mjs';
import { readJunitReport } from './junit.mjs';
import { evaluateJvmRun, firstBuildError, listReportFiles, listedManifest, parseJvmReport } from './jvm.mjs';
import { walk } from '../../util/glob.mjs';

/**
 * The Karma adapter for Angular (#329). Explicit only: `--runner karma`. `auto`
 * never picks it, but finding Karma is what turns the misleading "npm i -D
 * vitest" advice into one that says Karma was found and how to run it.
 *
 * `run` starts `ng test <project> --watch=false --browsers=ChromeHeadless
 * --karma-config=<generated> --include=<spec>...`. The report location is the
 * weak point of Karma: `karma-junit-reporter` writes where the project's own
 * `karma.conf.js` says. So the adapter generates a small config in the scratch
 * directory that loads the project's config, then forces the JUnit reporter and
 * an output directory under scratch. The project's config is therefore
 * required; `ng generate config karma` makes one.
 *
 * Limits, all of them unverified against a real Karma or Chrome in this tree
 * (the tests use a fake `ng` that loads the generated config):
 * - `karma-junit-reporter` reports one suite per browser, never per spec file,
 *   so the run cannot say a requested spec did not run; `--include` selects it
 *   and a run that collects no test is an `error`.
 * - Jasmine failures carry no exception type, so every kill reads as an
 *   exception, never an assertion. `--require-assertion-kill` cannot be met.
 * - `--karma-config` and `--include` are read from the Angular CLI's documented
 *   options for the `@angular-devkit/build-angular:karma` and
 *   `@angular/build:karma` builders; other builders are not supported.
 */
export const name = 'karma';
export const extensions = JS_EXTENSIONS;
export const testGlobs = ['**/*.spec.ts'];
export const parseReport = parseJvmReport;
/** The negative control's edit: a TypeScript parse error. */
export const fatalEdit = () => '/* testguard negative control: this file must not parse */\n(\n';

export const tests = (projectDir) => listTestFiles(projectDir, testGlobs);

const isKarmaTarget = (project) => /:karma$/.test(String((project?.architect ?? project?.targets)?.test?.builder ?? ''));

/** The parsed angular.json of a project, or null. */
function readAngular(projectDir) {
  try { return parseJsonc(readFileSync(join(projectDir, 'angular.json'), 'utf8')); } catch { return null; }
}

/**
 * Does this project use Karma? Read from `angular.json` (a karma test builder)
 * and `package.json` (a `karma` dependency). Pure but for two file reads.
 * Returns `{ found: true, why }` or null.
 */
export function detectKarma(projectDir) {
  const angular = readAngular(projectDir);
  if (angular && Object.values(angular.projects ?? {}).some(isKarmaTarget)) return { found: true, why: 'angular.json has a karma test builder' };
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
    if ({ ...pkg.dependencies, ...pkg.devDependencies }.karma !== undefined) return { found: true, why: 'package.json lists karma' };
  } catch { /* no package.json, or one that is not JSON: no evidence of Karma */ }
  return null;
}

/** The Angular project, with a karma test target, whose root is the longest prefix of `file`. */
export function angularProjectFor(angular, file) {
  let best = null;
  for (const [projectName, project] of Object.entries(angular?.projects ?? {})) {
    if (!isKarmaTarget(project)) continue;
    const root = String(project.root ?? '').replace(/\/$/, '');
    if (root !== '' && file !== root && !file.startsWith(`${root}/`)) continue;
    if (best === null || root.length > best.root.length) best = { name: projectName, root };
  }
  return best?.name ?? null;
}

/** The Karma config a project names, else `karma.conf.js` in its root, else null. `exists` is the project-relative file test. */
export function karmaConfigFor(angular, projectName, exists) {
  const project = angular?.projects?.[projectName];
  const named = (project?.architect ?? project?.targets)?.test?.options?.karmaConfig;
  if (typeof named === 'string' && named) return named;
  const root = String(project?.root ?? '').replace(/\/$/, '');
  const conventional = root ? `${root}/karma.conf.js` : 'karma.conf.js';
  return exists(conventional) ? conventional : null;
}

/** The `ng test` command line, as data. */
export const ngArgv = ({ ng, project, config, files }) => [
  ...ng, 'test', project, '--watch=false', '--browsers=ChromeHeadless', `--karma-config=${config}`, ...files.map((file) => `--include=${file}`),
];

/** The generated Karma config: the project's own, then the JUnit reporter forced into `outDir`. */
export function karmaWrapperSource({ projectDir, base, outDir }) {
  return `'use strict';
// Generated by testguard (--runner karma): the project's Karma config, with the JUnit reporter forced into a scratch directory.
const { createRequire } = require('node:module');
const projectRequire = createRequire(${JSON.stringify(join(projectDir, 'package.json'))});
const base = projectRequire(${JSON.stringify(base)});
module.exports = function (config) {
  base(config);
  config.set({
    reporters: ['junit'],
    plugins: [...(config.plugins || []), projectRequire('karma-junit-reporter')],
    junitReporter: { outputDir: ${JSON.stringify(outDir)}, outputFile: 'karma.xml', useBrowserName: false },
    singleRun: true,
    autoWatch: false,
  });
};
`;
}

const ANSI = /\x1b\[[0-9;]*m/g;
/** The line of `ng test` output that says why a build failed: a TypeScript error, else the first `Error`, else Maven-style. */
export function firstNgError(log) {
  const lines = String(log ?? '').replace(ANSI, '').split(/\r?\n/).map((line) => line.trim());
  return lines.find((line) => /\berror TS\d+\b/.test(line)) ?? lines.find((line) => /^(?:Error\b|✖|X \[ERROR\])/.test(line)) ?? firstBuildError(log);
}

export async function check({ projectDir } = {}) {
  if (!existsSync(join(projectDir, 'angular.json'))) {
    return { ok: false, message: 'no angular.json in the project directory; the karma adapter runs Angular projects through `ng test`. Use --runner-cmd with --report-format junit for another Karma setup' };
  }
  const cli = resolveRunner({ projectDir, pkg: '@angular/cli', bin: 'ng' });
  if (!cli) return { ok: false, message: '@angular/cli is not installed in the project (npm i -D @angular/cli)' };
  if (!resolvable(projectDir, 'karma-junit-reporter/package.json')) {
    return { ok: false, message: 'karma-junit-reporter is not installed in the project (npm i -D karma-junit-reporter); the karma adapter reads the JUnit XML it writes' };
  }
  const angular = readAngular(projectDir);
  const configs = Object.entries(angular?.projects ?? {}).filter(([, project]) => isKarmaTarget(project)).map(([projectName]) => karmaConfigFor(angular, projectName, (rel) => existsSync(join(projectDir, rel))));
  if (!configs.some(Boolean)) {
    return { ok: false, message: 'no Karma config for any Angular project with a karma test builder (ng generate config karma); the karma adapter loads it and adds the JUnit reporter' };
  }
  return { ok: true, version: cli.version, source: cli.source };
}

function resolvable(projectDir, request) {
  try { createRequire(join(projectDir, 'package.json')).resolve(request); return true; } catch { return false; }
}

const CONFIG_CANDIDATES = (projectDir) => {
  const names = new Set(['angular.json', 'karma.conf.js', 'karma.conf.cjs', 'tsconfig.json', 'tsconfig.spec.json']);
  for (const file of walk(projectDir)) if (/(?:^|\/)karma[^/]*\.conf\.c?js$|(?:^|\/)karma\.conf[^/]*\.c?js$|(?:^|\/)tsconfig\.spec\.json$/.test(file)) names.add(file);
  return [...names].sort();
};

export const discoverTests = async ({ projectDir, version }) => listedManifest({ runner: name, version, projectDir, list: tests, candidates: CONFIG_CANDIDATES });

const noRun = (message) => ({ run: { outcome: 'error', tests: { total: 0, passed: 0, failed: 0 }, assertionFailures: 0, exceptionFailures: 0, durationMs: 0 }, timeouts: 0, loadMessage: message, failedTests: [] });

async function runGroup({ projectDir, ng, project, base, files, budgetMs, opts }) {
  const outDir = mkdtempSync(join(scratchRoot(), 'testguard-karma-'));
  try {
    const wrapper = join(outDir, 'karma.wrapper.cjs');
    writeFileSync(wrapper, karmaWrapperSource({ projectDir, base: join(projectDir, base), outDir: join(outDir, 'out') }));
    return await runProcess({
      ...opts,
      budgetMs,
      command: ngArgv({ ng, project, config: wrapper, files }),
      captureStdout: true,
      collect: ({ exit, stdout, durationMs, startedAt }) => {
        const reports = listReportFiles(outDir, ['out'], startedAt);
        return evaluateJvmRun({ report: reports.length ? readJunitReport(reports) : null, exit, requested: [], durationMs, stdout, explain: firstNgError });
      },
    });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * Run spec files with `ng test`, one run per Angular project that holds them.
 * Under `--runner-cmd` the adapter steps aside.
 */
export async function run(opts) {
  if (opts.commandTemplate !== undefined) return runProcess({ ...opts, argv: undefined });
  const { projectDir, files, budgetMs = 120_000 } = opts;
  const angular = readAngular(projectDir);
  const cli = resolveRunner({ projectDir, pkg: '@angular/cli', bin: 'ng' });
  if (!angular || !cli) return noRun('the karma adapter needs angular.json and @angular/cli in the project');
  const groups = new Map();
  for (const file of [...files].sort()) {
    const project = angularProjectFor(angular, file);
    if (project === null) return noRun(`${file} is in no Angular project with a karma test target in angular.json`);
    groups.set(project, [...(groups.get(project) ?? []), file]);
  }
  const deadline = performance.now() + budgetMs;
  const parts = [];
  for (const [project, group] of groups) {
    const base = karmaConfigFor(angular, project, (rel) => existsSync(join(projectDir, rel)));
    if (base === null) return noRun(`Angular project ${project} has no Karma config (ng generate config karma)`);
    const part = await runGroup({ projectDir, ng: cli.argv, project, base, files: group, budgetMs: Math.max(1, Math.floor(deadline - performance.now())), opts });
    parts.push(part);
    if (part.run.outcome === 'timeout') break;
  }
  return mergeRuns(parts);
}
