import { parseCommandTemplate } from '../probe/runners/shared.mjs';
import { REPORT_FORMATS } from '../probe/runners/junit.mjs';
import { checkTestGlob, normalizeTestGlobs } from '../probe/test-globs.mjs';

/**
 * The runner options every command that runs tests shares — probe, admit,
 * sweep, replay — checked once, before any work. A malformed `--runner-cmd` is
 * a usage error (exit 3) with the reason, never a RangeError surfacing as
 * "this is a bug in testguard"; and an empty value was asked for, so it is
 * refused rather than read as "no command".
 *
 * `--report-format` (jest, the default, or junit) names the format of a
 * `--runner-cmd` report and means nothing without one.
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
  // How a command's report is read (#329). It says how to read a command, so it needs one.
  const reportFormat = values['report-format'];
  if (reportFormat !== undefined) {
    if (!REPORT_FORMATS.includes(reportFormat)) return { error: `--report-format must be ${REPORT_FORMATS.join(' or ')} (got ${JSON.stringify(reportFormat)})` };
    if (runnerCommand === undefined) return { error: '--report-format needs --runner-cmd: it says how to read the report of a custom command' };
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
  return { runnerCommand, reportFormat, ...(globs.length ? { testGlobs: globs } : {}), python };
}
