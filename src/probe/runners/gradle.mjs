import { listTestFiles } from './shared.mjs';
import {
  JAVA_TEST_GLOBS, KOTLIN_TEST_GLOBS, JVM_EXTENSIONS, BUILD_TOOLS, checkJvm, runJvm, testClassOf, isJvmTestPath, hasBuildFile,
  parseJvmReport, jvmFatalEdit, buildConfigCandidates, listedManifest,
} from './jvm.mjs';
import { javaProducers } from '../../scaffold/producers.java.mjs';

/**
 * The Gradle adapter (#329). Explicit only: `--runner gradle`. `auto` never
 * picks it.
 *
 * `check` runs the project's `./gradlew` when it has one, else `gradle` from
 * PATH. `run` starts `cleanTest test --tests <class>` for each module with a
 * defender, then reads the JUnit XML under `build/test-results/test`. Three
 * flags are not optional:
 *
 * - `--no-daemon`: a daemon outlives the process tree, so the budget could not
 *   end the run and a later run could inherit its state;
 * - `cleanTest` and `--no-build-cache`: an up-to-date or cached `test` task
 *   writes no new report, and a report restored from a cache is not a run, so
 *   neither may stand in for one;
 * - `--continue`: every module's tests are attempted, so a defender in a
 *   second module is not missing because the first failed.
 *
 * Only the `test` task is read. A module is the directory of the nearest
 * `build.gradle(.kts)` and its Gradle path is its directory path with `:`; a
 * project that renames a module's directory in `settings.gradle` needs
 * `--runner-cmd --report-format junit`. Not run against a real Gradle in this
 * tree: the tests use a fake `gradle` that writes the files it is documented to.
 */
export const name = 'gradle';
export const extensions = JVM_EXTENSIONS;
export const testGlobs = [...JAVA_TEST_GLOBS, ...KOTLIN_TEST_GLOBS];
/** The Java fault shapes `scaffold` and `sweep` use for a `.java` file in a Gradle project. */
export const producers = javaProducers;
export const fatalEdit = jvmFatalEdit;
export const parseReport = parseJvmReport;

export const tests = (projectDir) => listTestFiles(projectDir, testGlobs);
/** A conventional JUnit test file, in a project built with Gradle. */
export const owns = (projectDir, file) => isJvmTestPath(file) && hasBuildFile(projectDir, file, BUILD_TOOLS.gradle.markers);

export const check = (opts) => checkJvm('gradle', opts);
export const discoverTests = async ({ projectDir, version }) => listedManifest({
  runner: name, version, projectDir, list: tests, candidates: (dir) => buildConfigCandidates('gradle', dir),
});

/** `:a:b:` for the module `a/b`, `:` for the project itself. */
export const taskPrefix = (module) => (module ? `:${module.split('/').join(':')}:` : ':');

/** The command line, as data: one `cleanTest test --tests ...` group per module. */
export function gradleArgv({ tool, groups }) {
  const argv = [tool, '--no-daemon', '--console=plain', '--no-build-cache', '--continue'];
  for (const [module, files] of groups) {
    const prefix = taskPrefix(module);
    argv.push(`${prefix}cleanTest`, `${prefix}test`);
    for (const file of files) argv.push('--tests', testClassOf(file));
  }
  return argv;
}

export const run = (opts) => runJvm('gradle', gradleArgv, opts);
