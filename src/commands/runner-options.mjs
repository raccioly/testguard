import { parseCommandTemplate } from '../probe/runners/shared.mjs';
import { checkTestGlob, normalizeTestGlobs } from '../probe/test-globs.mjs';

/**
 * The runner options every command that runs tests shares — probe, admit,
 * sweep, replay — checked once, before any work. A malformed `--runner-cmd` is
 * a usage error (exit 3) with the reason, never a RangeError surfacing as
 * "this is a bug in testguard"; and an empty value was asked for, so it is
 * refused rather than read as "no command".
 *
 * `--test-glob` (repeatable; `testGlobs` in the config file) names the tests of a
 * suite the built-in globs do not list. It only means something beside a
 * custom command, so without one it is refused rather than ignored (#332).
 *
 * `python` is passed through as typed. Whether it is a command on PATH or a
 * path is decided in one place (`explicitInterpreter`), the same way for
 * `--python` and `TESTGUARD_PYTHON`.
 */
export function runnerOptions(values) {
  const runnerCommand = values['runner-cmd'];
  if (runnerCommand !== undefined) {
    try {
      parseCommandTemplate(runnerCommand);
    } catch (error) {
      return { error: error.message };
    }
  }
  const testGlobs = values['test-glob'] ?? [];
  for (const glob of testGlobs) {
    const problem = checkTestGlob(glob);
    if (problem) return { error: `--test-glob ${JSON.stringify(glob)} ${problem}` };
  }
  if (testGlobs.length > 0 && runnerCommand === undefined) {
    return { error: '--test-glob needs --runner-cmd: it names the tests of a custom command\'s suite, and a built-in runner lists its own tests' };
  }
  const python = values.python;
  if (python !== undefined && python.trim() === '') {
    return { error: '--python must name an interpreter: a path such as .venv/bin/python, or a command on PATH such as python3' };
  }
  const globs = normalizeTestGlobs(testGlobs);
  return { runnerCommand, ...(globs.length ? { testGlobs: globs } : {}), python };
}
