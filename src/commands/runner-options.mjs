import { parseCommandTemplate } from '../probe/runners/shared.mjs';

/**
 * The runner options every command that runs tests shares — probe, admit,
 * sweep, replay — checked once, before any work. A malformed `--runner-cmd` is
 * a usage error (exit 3) with the reason, never a RangeError surfacing as
 * "this is a bug in testguard"; and an empty value was asked for, so it is
 * refused rather than read as "no command".
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
  const python = values.python;
  if (python !== undefined && python.trim() === '') {
    return { error: '--python must name an interpreter: a path such as .venv/bin/python, or a command on PATH such as python3' };
  }
  return { runnerCommand, python };
}
