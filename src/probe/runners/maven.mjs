import { listTestFiles } from './shared.mjs';
import {
  JAVA_TEST_GLOBS, KOTLIN_TEST_GLOBS, JVM_EXTENSIONS, BUILD_TOOLS, checkJvm, runJvm, isJvmTestPath, hasBuildFile,
  parseJvmReport, jvmFatalEdit, buildConfigCandidates, listedManifest,
} from './jvm.mjs';
import { javaProducers } from '../../scaffold/producers.java.mjs';

/**
 * The Maven adapter (#329). Explicit only: `--runner maven`. `auto` never picks
 * it, because a `pom.xml` says a project is built with Maven, not that
 * TestGuard may run its tests.
 *
 * `check` runs the project's `./mvnw` when it has one, else `mvn` from PATH, and
 * reports `--version`. `run` maps each defender file to its class and starts
 * `mvn test -Dtest=<classes>` (with `-pl <module> -am` when a defender lives in
 * a module below the project), then reads the JUnit XML that Surefire and
 * Failsafe write under each module's `target`. The report directories are
 * removed before the build, so a report of an earlier run is never read. A
 * compile error leaves no report: the run is an `error`, which the engine
 * reports as `fault-invalid` for a fault and as a load failure for a defender.
 *
 * Not run against a real Maven in this tree: the tests use a fake `mvn` that
 * writes the files Surefire is documented to write.
 */
export const name = 'maven';
export const extensions = JVM_EXTENSIONS;
export const testGlobs = [...JAVA_TEST_GLOBS, ...KOTLIN_TEST_GLOBS];
/** The Java fault shapes `scaffold` and `sweep` use for a `.java` file in a Maven project. */
export const producers = javaProducers;
export const fatalEdit = jvmFatalEdit;
export const parseReport = parseJvmReport;

export const tests = (projectDir) => listTestFiles(projectDir, testGlobs);
/** A conventional JUnit test file, in a project built with Maven. */
export const owns = (projectDir, file) => isJvmTestPath(file) && hasBuildFile(projectDir, file, BUILD_TOOLS.maven.markers);

export const check = (opts) => checkJvm('maven', opts);
export const discoverTests = async ({ projectDir, version }) => listedManifest({
  runner: name, version, projectDir, list: tests, candidates: (dir) => buildConfigCandidates('maven', dir),
});

/**
 * The command line, as data: `-Dtest` carries the classes, Surefire is told an
 * unmatched class is not a failure (a module without it has nothing to run, and
 * the run reports a defender with no suite as an error), and a defender below
 * the project selects its module with `-pl` and the modules it needs with `-am`.
 */
export function mavenArgv({ tool, groups, classes }) {
  const modules = [...groups.keys()];
  const below = modules.filter((module) => module !== '');
  return [
    tool, '-B', 'test', `-Dtest=${classes.join(',')}`, '-Dsurefire.failIfNoSpecifiedTests=false', '-DfailIfNoTests=false',
    ...(below.length ? ['-pl', modules.map((module) => module || '.').join(','), '-am'] : []),
  ];
}

export const run = (opts) => runJvm('maven', mavenArgv, opts);
