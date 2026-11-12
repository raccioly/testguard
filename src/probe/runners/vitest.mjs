import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scratchRoot } from '../../scratch-dir.mjs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TEST_GLOBS, runProcess, checkRunner, runnerArgv, listTestFiles, parseReport, resolveRunner, mergeRuns } from './shared.mjs';
import { nearestNodeModulesWritable } from '../node-modules-link.mjs';
import { createDiscoveryManifest, DiscoveryError, hashDiscoveryConfigs, normalizeDiscoveredEntries, readBoundedJsonFile, runDiscoveryProcess } from './discovery.mjs';

export const name = 'vitest';
export const testGlobs = TEST_GLOBS;
export const check = (opts) => checkRunner({ ...opts, pkg: 'vitest', bin: 'vitest' });
export const tests = (projectDir) => listTestFiles(projectDir, testGlobs);
const DISCOVERY_CONFIG_FILES = [
  ...['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].flatMap((ext) => [`vitest.config.${ext}`, `vite.config.${ext}`, `vitest.workspace.${ext}`]),
  'vitest.workspace.json',
];
/**
 * Discovery runs in the caller's own tree, whose node_modules cannot be swapped
 * for a scratch one. Vitest's default config loader bundles the config to a
 * temp file under `node_modules/.vite-temp` and dies with EACCES when that
 * install is read-only (a confined container). `--configLoader runner` loads
 * it in process and writes nothing; verified on vitest 5.0.2. It is asked for
 * only when the install is not writable (so a writable project keeps the
 * loader it always had) and only on a vitest that has the flag (4 and later).
 */
export const configLoaderArgs = (projectDir) => {
  const major = Number.parseInt(resolveRunner({ projectDir, pkg: 'vitest', bin: 'vitest' })?.version ?? '', 10);
  return major >= 4 && nearestNodeModulesWritable(projectDir) === false ? ['--configLoader', 'runner'] : [];
};

/**
 * Ask Vitest itself to load config and enumerate the files it would collect.
 * `jsonFile`: write the listing as JSON there (`--json=<file>`, vitest 3 and
 * later; recorded under test/samples/vitest-list). A file, not stdout, so a
 * config that logs cannot corrupt it.
 */
export const discoveryArgvFor = (projectDir, { jsonFile } = {}) => [...runnerArgv(projectDir, 'vitest', 'vitest'), 'list', '--filesOnly', '--passWithNoTests', '--maxWorkers=1', ...configLoaderArgs(projectDir), ...(jsonFile ? [`--json=${jsonFile}`] : [])];

const PROJECT_LINE = /^\[([^\]]+)\] (.+)$/;

/**
 * The text listing: one file per line, prefixed `[project] ` when the config
 * sets `test.projects` (#277). A line that names an existing file as a whole
 * is that file, so a directory called `[slug]` is not read as a project.
 */
export function parseDiscoveryOutput(stdout, exists = () => false) {
  if (typeof stdout !== 'string') throw new TypeError('Vitest discovery output must be text');
  return stdout.split(/\r?\n/).filter((line) => line.length > 0).map((line) => {
    const prefixed = PROJECT_LINE.exec(line);
    return prefixed && !exists(line) ? { file: prefixed[2], project: prefixed[1] } : { file: line };
  });
}

/** The `--json` listing: `[{ file, projectName? }]`. */
export function parseDiscoveryReport(report) {
  if (!Array.isArray(report)) throw new DiscoveryError('Vitest discovery report must be a JSON array');
  return report.map((entry) => {
    if (entry == null || typeof entry !== 'object' || typeof entry.file !== 'string') throw new DiscoveryError('Vitest discovery report entries must name a file');
    if (entry.projectName !== undefined && typeof entry.projectName !== 'string') throw new DiscoveryError('Vitest discovery report project names must be strings');
    return entry.projectName ? { file: entry.file, project: entry.projectName } : { file: entry.file };
  });
}

const supportsJsonListing = (version) => Number.parseInt(version ?? '', 10) >= 3;

export async function discoverTests({ projectDir, version, timeoutMs, maxOutputBytes } = {}) {
  const before = hashDiscoveryConfigs(projectDir, DISCOVERY_CONFIG_FILES);
  let entries;
  if (supportsJsonListing(version)) {
    const jsonFile = join(scratchRoot(), `testguard-vitest-list-${randomBytes(8).toString('hex')}.json`);
    try {
      await runDiscoveryProcess({ projectDir, argv: discoveryArgvFor(projectDir, { jsonFile }), timeoutMs, maxOutputBytes });
      entries = parseDiscoveryReport(readBoundedJsonFile(jsonFile, maxOutputBytes));
    } finally {
      rmSync(jsonFile, { force: true });
    }
  } else {
    const result = await runDiscoveryProcess({ projectDir, argv: discoveryArgvFor(projectDir), timeoutMs, maxOutputBytes });
    entries = parseDiscoveryOutput(result.stdout, (line) => existsSync(join(projectDir, line)));
  }
  const configFiles = hashDiscoveryConfigs(projectDir, DISCOVERY_CONFIG_FILES);
  if (JSON.stringify(configFiles) !== JSON.stringify(before)) throw new DiscoveryError('Vitest discovery config changed while tests were being listed');
  const { files, projects } = normalizeDiscoveredEntries(projectDir, entries);
  const names = [...new Set(Object.values(projects).flat())];
  for (const project of names) projectSelector(project, names); // refuse a project that cannot be run alone, at discovery
  return createDiscoveryManifest({ runner: name, version, files, configFiles, projects });
}

// Vitest's own project filter: `*` is a wildcard, the match is whole-name and
// case-insensitive, and a leading `!` negates.
const projectFilterRegExp = (pattern) => new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

/**
 * The `--project` value that selects exactly `project` among the listed
 * project names. A name vitest's argument parser reads as a number (an
 * unnamed project is listed as "0") or as a negation is written as a
 * pattern; any selector that would also match another listed project is
 * refused, because running that project too could count its failures as the
 * defender's. Projects that list no file cannot run any file.
 */
export function projectSelector(project, allProjects) {
  const numeric = project.trim() !== '' && Number.isFinite(Number(project));
  const selector = project.startsWith('!') ? `*${project}` : numeric ? `${project}*` : project;
  const filter = projectFilterRegExp(selector);
  if (!filter.test(project) || allProjects.some((other) => other !== project && filter.test(other))) {
    throw new DiscoveryError(`vitest project "${project}" cannot be selected on its own with --project (it would also select another project); give each project a distinct name (test.name)`);
  }
  return selector;
}

/**
 * The invocations a set of defenders needs: one per project that lists any
 * of them, each with that project's files, plus one without `--project` for
 * files listed under no project. A file under two projects runs in both.
 */
export function projectRuns(files, projects = {}) {
  const plain = [];
  const byProject = new Map();
  for (const file of files) {
    const names = projects[file];
    if (!names?.length) { plain.push(file); continue; }
    for (const project of names) {
      if (!byProject.has(project)) byProject.set(project, []);
      byProject.get(project).push(file);
    }
  }
  const all = [...new Set(Object.values(projects).flat())];
  return [
    ...(plain.length ? [{ project: null, files: plain }] : []),
    ...[...byProject].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([project, group]) => ({ project, selector: projectSelector(project, all), files: group })),
  ];
}
// --serial: one file at a time in one process, so a contended machine cannot turn a slow suite into a TIMEOUT verdict.
/** The command line, as data. Exported so it is falsifiable without spawning anything. */
export const argvFor = (projectDir, files, outFile, { serial = false, workers = 1, project } = {}) =>
  [...runnerArgv(projectDir, 'vitest', 'vitest'), 'run', ...files, '--reporter=json', `--reporter=${KINDS_REPORTER}`, `--outputFile=${outFile}`, `--maxWorkers=${serial ? 1 : workers}`, ...(serial || workers === 1 ? ['--no-file-parallelism'] : []), ...(project ? [`--project=${project}`] : [])];
/**
 * vitest's JSON report keeps only error stack text, so a second, injected
 * reporter records each failed test's structured error identity in a sidecar
 * file. Missing or unreadable sidecar: every failure is an exception, which
 * is the pessimistic side. A `--runner-cmd` never gets it.
 */
export const KINDS_REPORTER = join(dirname(fileURLToPath(import.meta.url)), 'vitest', 'kinds-reporter.mjs');

async function runOnce(opts, project) {
  const sidecar = join(scratchRoot(), `testguard-vitest-kinds-${randomBytes(6).toString('hex')}.json`);
  const readKinds = () => {
    try { return existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, 'utf8')) : undefined; } catch { return undefined; }
  };
  try {
    return await runProcess({ ...opts, env: { ...opts.env, TESTGUARD_VITEST_KINDS: sidecar }, parse: (report, durationMs) => parseReport(report, durationMs, readKinds()), argv: (files, outFile) => argvFor(opts.projectDir, files, outFile, { ...opts, project }) });
  } finally { rmSync(sidecar, { force: true }); }
}

/**
 * `opts.projects` is the discovered project membership (#277). Each project
 * that lists a defender gets its own run, selected with `--project`, and the
 * runs merge pessimistically, as runs of different runners do: a failure,
 * timeout or load error under any project is one for the defender set. The
 * runs share the caller's budget. A custom command never gets a project.
 */
export async function run(opts) {
  const groups = opts.commandTemplate ? [] : projectRuns(opts.files ?? [], opts.projects);
  if (groups.length <= 1 && !groups[0]?.project) return runOnce(opts);
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 120_000;
  const parts = [];
  for (const group of groups) {
    parts.push(await runOnce({ ...opts, files: group.files, budgetMs: Math.max(1, budgetMs - (Date.now() - started)) }, group.selector));
  }
  return mergeRuns(parts);
}

/**
 * The negative control's edit: content this runner's loader cannot possibly
 * parse. Used to prove the defenders actually execute a file before a
 * `survived` verdict about it is allowed to stand. An unterminated group is
 * a syntax error at every JavaScript/TypeScript parser, whatever the file
 * contained before.
 */
export const fatalEdit = () => '/* testguard negative control: this file must not parse */\n(\n';
