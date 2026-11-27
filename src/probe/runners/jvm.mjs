import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { registerChild } from './lifecycle.mjs';
import { runProcess, terminateAtBudget, terminateProcessTree, parseReport as parseJestReport } from './shared.mjs';
import { readJunitReport } from './junit.mjs';
import { createDiscoveryManifest, DiscoveryError, hashDiscoveryConfigs } from './discovery.mjs';
import { walk } from '../../util/glob.mjs';

/**
 * What the Maven and Gradle adapters share (#329): JUnit-style test layout,
 * the module a test file belongs to, where a build writes its reports, how a
 * finished build is judged, and how the build tool is found.
 *
 * Nothing here is verified against a real Maven or Gradle in this tree. The
 * adapters are tested with fake executables that write the report files these
 * tools are documented to write.
 */

/** Surefire's default test class names, under the Maven and Gradle source-set layout. */
export const JAVA_TEST_GLOBS = Object.freeze(['**/src/test/java/**/*Test.java', '**/src/test/java/**/*Tests.java', '**/src/test/java/**/*TestCase.java', '**/src/test/java/**/Test*.java']);
export const KOTLIN_TEST_GLOBS = Object.freeze(['**/src/test/kotlin/**/*Test.kt', '**/src/test/kotlin/**/*Tests.kt', '**/src/test/kotlin/**/*TestCase.kt', '**/src/test/kotlin/**/Test*.kt']);
export const JVM_EXTENSIONS = Object.freeze(['.java', '.kt']);

const TEST_SOURCE = /(?:^|\/)src\/test\/(?:java|kotlin)\/(.+)\.(?:java|kt)$/;

/** The fully qualified class a test file declares by its place in the source set, or null. Pure. */
export const testClassOf = (file) => TEST_SOURCE.exec(file)?.[1].replaceAll('/', '.') ?? null;

/** Is this path a conventional JVM test file? Pure; the adapters' `owns` adds the build file check. */
export const isJvmTestPath = (file) => testClassOf(file) !== null && /(?:Tests?|TestCase)\.(?:java|kt)$|(?:^|\/)Test[^/]*\.(?:java|kt)$/.test(file);

/**
 * The module a file belongs to: the nearest directory, from the file up to the
 * project, that holds one of `markers`. `''` is the project root, which is also
 * the answer when no build file is found. Reads the file system.
 */
export function moduleOf(projectDir, file, markers) {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const rel = dir === '.' || dir === '/' ? '' : dir;
    if (markers.some((marker) => existsSync(join(projectDir, rel, marker)))) return rel;
    if (rel === '') return '';
  }
}

/** Is there a build file in the directory of `file`, or in any directory above it up to the project? */
export function hasBuildFile(projectDir, file, markers) {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const rel = dir === '.' || dir === '/' ? '' : dir;
    if (markers.some((marker) => existsSync(join(projectDir, rel, marker)))) return true;
    if (rel === '') return false;
  }
}

/** `Map<module, files[]>`, modules and files in sorted order. */
export function groupByModule(projectDir, files, markers) {
  const groups = new Map();
  for (const file of [...files].sort()) {
    const module = moduleOf(projectDir, file, markers);
    if (!groups.has(module)) groups.set(module, []);
    groups.get(module).push(file);
  }
  return new Map([...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const underModule = (module, path) => (module ? `${module}/${path}` : path);

/** Where each build tool writes its JUnit XML for one module, relative to the project. */
export const reportDirsFor = (kind, module) => (kind === 'maven'
  ? [underModule(module, 'target/surefire-reports'), underModule(module, 'target/failsafe-reports')]
  : [underModule(module, 'build/test-results/test')]);

/** Remove the report directories of a build, so what is read afterwards was written by this run. */
export function clearReports(projectDir, dirs) {
  for (const dir of dirs) rmSync(join(projectDir, dir), { recursive: true, force: true });
}

/**
 * The XML files under `dirs` that this run could have written: regular files
 * (never a link) ending in `.xml`, modified no more than two seconds before the
 * run started. The two seconds cover a file system that keeps whole seconds.
 */
export function listReportFiles(projectDir, dirs, startedAt) {
  const found = [];
  for (const dir of dirs) {
    let entries;
    try { entries = readdirSync(join(projectDir, dir), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.xml')) continue;
      const path = join(projectDir, dir, entry.name);
      try { if (lstatSync(path).mtimeMs >= startedAt - 2000) found.push(path); } catch { /* gone between listing and stat */ }
    }
  }
  return found.sort();
}

const ANSI = /\x1b\[[0-9;]*m/g;
const COMPILER_LINE = /\.(?:java|kt)(?::\[?\d+|\b.*\berror\b)/;

/**
 * The line of a build log that says why it failed, or null: the compiler's own
 * line first, then Gradle's "What went wrong", then the first Maven `[ERROR]`.
 * Pure; reads only the text it is given.
 */
export function firstBuildError(log) {
  const lines = String(log ?? '').replace(ANSI, '').split(/\r?\n/).map((line) => line.trimEnd());
  const stripped = (line) => line.replace(/^\[ERROR\]\s*/, '').trim();
  const maven = lines.filter((line) => /^\[ERROR\]\s+\S/.test(line) && !/-> \[Help \d+\]/.test(line)).map(stripped);
  const compiler = [...lines.map((line) => (line.startsWith('[ERROR]') ? stripped(line) : line.trim())).filter((line) => COMPILER_LINE.test(line) && !/^\[?INFO\b/.test(line))];
  if (compiler.length) return compiler[0];
  const kotlin = lines.find((line) => /^e: \S/.test(line));
  if (kotlin) return kotlin.trim();
  const wrong = lines.findIndex((line) => /^\* What went wrong:/.test(line));
  if (wrong !== -1) {
    const next = lines.slice(wrong + 1).find((line) => line.trim());
    if (next) return next.trim();
  }
  const gradle = lines.find((line) => /^(?:error: |FAILURE: )\S/.test(line));
  if (gradle) return gradle.trim();
  const generic = maven.find((line) => !/^(?:BUILD FAILURE|COMPILATION ERROR)/.test(line));
  return generic ?? null;
}

/** `exit` is a number, or the text runProcess passes (`code 1`, `signal SIGKILL`). */
const describeExit = (exit) => (typeof exit === 'number' ? `code ${exit}` : String(exit));
const suiteRan = (report, cls) => report.testResults.some((s) => s.name === cls || s.name.startsWith(`${cls}$`));

/**
 * Judge a finished build. `report` is the jest-shaped report of the JUnit XML
 * this run wrote, or null when it wrote none. Never optimistic:
 *
 * - no report is an `error`, with the build's own words when it printed any;
 * - a requested class with no suite in the reports is an `error` (a selector
 *   that matched nothing is zero observations, not a pass);
 * - a build that exited non-zero beside reports that show no failure is an
 *   `error` (another module may not have built, and its tests are missing).
 *
 * `explain` turns the build's output into the line that says why (the Karma
 * adapter reads Angular's, not Maven's).
 */
export function evaluateJvmRun({ report, exit, requested, durationMs, stdout, explain = firstBuildError }) {
  const noRun = { total: 0, passed: 0, failed: 0 };
  const error = (loadMessage) => ({ run: { outcome: 'error', tests: noRun, assertionFailures: 0, exceptionFailures: 0, durationMs }, timeouts: 0, loadMessage, failedTests: [] });
  const why = explain(stdout);
  if (!report) return error(why ?? `the build wrote no test report (exited with ${describeExit(exit)}); a compile error or a selector that matched no test leaves none`);
  const missing = requested.filter((cls) => !suiteRan(report, cls));
  if (missing.length) return error(`no test report for ${missing.join(', ')}: the class has no test method, is abstract, or the build did not run it${why ? `; the build said: ${why}` : ''}`);
  const parsed = parseJestReport(report, durationMs);
  if (parsed.run.outcome === 'pass' && describeExit(exit) !== 'code 0') {
    return error(`the build exited with ${describeExit(exit)} but its reports show no failing test; a module may have failed to build${why ? `: ${why}` : ''}`);
  }
  return parsed;
}

/** The JUnit XML a build wrote, as the jest-shaped report `run` reads. Pure. */
export const parseJvmReport = (report, durationMs) => parseJestReport(report, durationMs);

/** The text that replaces a Java or Kotlin file so that it cannot compile: the negative control's edit. */
export const jvmFatalEdit = () => '// testguard negative control: this file must not compile\n(\n';

export const mavenVersion = (text) => /Apache Maven (\d[\w.-]*)/.exec(String(text))?.[1] ?? null;
export const gradleVersion = (text) => /^Gradle (\d[\w.-]*)/m.exec(String(text))?.[1] ?? null;

/** The build tools, by adapter name. */
export const BUILD_TOOLS = Object.freeze({
  maven: { bin: 'mvn', wrapper: 'mvnw', markers: ['pom.xml'], moduleMarkers: ['pom.xml'], version: mavenVersion, label: 'Maven' },
  gradle: { bin: 'gradle', wrapper: 'gradlew', markers: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'], moduleMarkers: ['build.gradle', 'build.gradle.kts'], version: gradleVersion, label: 'Gradle' },
});

/** The executable for a project: its own wrapper when it has one, else the tool on PATH. A wrapper is never second-guessed. */
export function toolFor(kind, dir) {
  const spec = BUILD_TOOLS[kind];
  const wrapper = join(dir, spec.wrapper);
  return existsSync(wrapper) ? { cmd: wrapper, source: 'project' } : { cmd: spec.bin, source: 'path' };
}

/** Run `cmd --version` under a time limit; the tree ends at the limit. Resolves `{ out }` or `{ error }`. */
function askVersion({ cmd, cwd, budgetMs, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, ['--version'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: { ...env, CI: '1' } });
    } catch (e) {
      return resolve({ error: e.message });
    }
    registerChild(child, () => terminateProcessTree(child));
    let out = '';
    let err = '';
    child.on('error', (e) => resolve({ error: e.code === 'ENOENT' ? 'not found' : e.message }));
    child.stdout.on('data', (d) => (out = (out + d).slice(-65536)));
    child.stderr.on('data', (d) => (err = (err + d).slice(-65536)));
    const timer = setTimeout(() => terminateAtBudget(child), budgetMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { out } : { error: (err || out).trim().split('\n').filter(Boolean).slice(-1)[0] ?? `exit ${code}` });
    });
  });
}

/**
 * Is the build tool usable here, and which version? Needs a build file in the
 * project, then runs the project's wrapper (`./mvnw`, `./gradlew`) or, when it
 * has none, the tool on PATH. Starts no test run. `env` is for tests.
 */
export async function checkJvm(kind, { projectDir, sourceDir, budgetMs = 30_000, env = process.env } = {}) {
  const spec = BUILD_TOOLS[kind];
  if (process.platform === 'win32') return { ok: false, message: `the ${kind} adapter is not verified on Windows; use --runner-cmd with --report-format junit` };
  // The directory the run will use: a scratch worktree holds only what git tracks, so a wrapper that git ignores is not found here, and `run` would not find it either.
  const dir = projectDir ?? sourceDir;
  if (!spec.markers.some((marker) => existsSync(join(dir, marker)))) {
    return { ok: false, message: `no ${spec.markers.join(' or ')} in the project directory; run from the module that has one, or use --runner-cmd with --report-format junit` };
  }
  const tool = toolFor(kind, dir);
  const answer = await askVersion({ cmd: tool.cmd, cwd: dir, budgetMs, env });
  if (answer.error) {
    const where = tool.source === 'project' ? `./${spec.wrapper}` : `\`${spec.bin}\``;
    return { ok: false, message: `${where} did not answer --version (${answer.error}); ${tool.source === 'project' ? `fix the wrapper, or delete it to use ${spec.bin} from PATH` : `install ${spec.label} or add a wrapper to the project`}` };
  }
  const version = spec.version(answer.out);
  if (!version) return { ok: false, message: `${tool.cmd} --version did not report a ${spec.label} version` };
  return { ok: true, version, source: tool.source };
}

/**
 * The build files that decide what the adapter's universe means: every pom.xml
 * or Gradle build file in the project, and the tool's own settings. Editing
 * one invalidates a reused verdict.
 */
export function buildConfigCandidates(kind, projectDir) {
  const spec = BUILD_TOOLS[kind];
  const names = new Set(kind === 'maven'
    ? ['pom.xml', '.mvn/maven.config', '.mvn/jvm.config', '.mvn/extensions.xml', '.mvn/wrapper/maven-wrapper.properties']
    : ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts', 'gradle.properties', 'gradle/libs.versions.toml', 'gradle/wrapper/gradle-wrapper.properties']);
  for (const file of walk(projectDir)) {
    const base = basename(file);
    if (spec.markers.includes(base) || base === 'gradle.properties') names.add(file);
  }
  return [...names].sort();
}

/** A universe manifest for an adapter that lists tests from the file system: files plus the hashes of its build files. */
export function listedManifest({ runner, version, projectDir, list, candidates }) {
  const before = hashDiscoveryConfigs(projectDir, candidates(projectDir));
  const files = list(projectDir);
  const configFiles = hashDiscoveryConfigs(projectDir, candidates(projectDir));
  if (JSON.stringify(configFiles) !== JSON.stringify(before)) throw new DiscoveryError(`${runner} build files changed while tests were being listed`);
  return createDiscoveryManifest({ runner, version, files, configFiles, source: 'adapter' });
}

/**
 * Run test files with a build tool and read the reports it wrote. `argv` is the
 * command line for `{ tool, groups, classes }`. The reports of every involved
 * module are removed first and only files written after the start are read.
 * Under `--runner-cmd` the adapter steps aside: `{out}` keeps its meaning.
 */
export function runJvm(kind, argv, opts) {
  if (opts.commandTemplate !== undefined) return runProcess({ ...opts, argv: undefined });
  const spec = BUILD_TOOLS[kind];
  const { projectDir, files, budgetMs = 120_000 } = opts;
  const classes = files.map(testClassOf);
  const noRun = (message) => Promise.resolve({ run: { outcome: 'error', tests: { total: 0, passed: 0, failed: 0 }, assertionFailures: 0, exceptionFailures: 0, durationMs: 0 }, timeouts: 0, loadMessage: message, failedTests: [] });
  if (classes.some((c) => c === null)) {
    return noRun(`${files.filter((f, i) => classes[i] === null).join(', ')} is not under src/test/java or src/test/kotlin, so ${spec.label} cannot select it by class`);
  }
  const groups = groupByModule(projectDir, files, spec.moduleMarkers);
  const dirs = [...groups.keys()].flatMap((module) => reportDirsFor(kind, module));
  clearReports(projectDir, dirs);
  const tool = toolFor(kind, projectDir);
  const command = argv({ tool: tool.cmd, groups, classes: [...new Set(classes)].sort() });
  return runProcess({
    ...opts,
    budgetMs,
    command,
    captureStdout: true,
    collect: ({ exit, stdout, durationMs, startedAt }) => {
      const reports = listReportFiles(projectDir, dirs, startedAt);
      return evaluateJvmRun({ report: reports.length ? readJunitReport(reports) : null, exit, requested: classes, durationMs, stdout });
    },
  });
}
