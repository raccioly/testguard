import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { PreconditionError } from '../probe/precondition-error.mjs';

/** The commands that write a document to `--out`, and the other output-file flag a command has. */
export const OUT_COMMANDS = new Set(['probe', 'sweep', 'replay', 'scaffold', 'gate', 'admit', 'brief', 'baseline']);
const EXTRA_OUT_FLAGS = { replay: ['calibration-out'] };

/**
 * `--out` names a file (#320). A directory there reached `renameSync` after the whole probe had run and
 * came out as "a bug in testguard", with every measurement lost. Refused first, as the precondition it is
 * (it depends on what is on disk, so exit 2, not the usage code): nothing is probed or written.
 * A path ending in a separator names a directory too, whether or not it exists yet.
 * Pure but for one `stat`; a path in a directory that does not exist yet is fine (the writer creates it).
 */
export function assertOutIsFile(value, flag = '--out') {
  if (value === undefined) return;
  let directory = false;
  try { directory = statSync(resolve(value)).isDirectory(); } catch { /* absent: a new file */ }
  if (directory) throw new PreconditionError(`${flag} names a file, and ${value} is a directory`, 'out-is-directory');
  if (/[\\/]$/.test(value)) throw new PreconditionError(`${flag} names a file, and ${value} ends with a path separator, which names a directory`, 'out-is-directory');
}

/** Every output-file flag a command was given, checked: one place for every command. */
export function assertOutputFlags(command, values) {
  if (!OUT_COMMANDS.has(command)) return;
  // brief --text and --markdown print and write nothing, so a stray --out there is not a destination.
  if (!(command === 'brief' && (values.text || values.markdown))) assertOutIsFile(values.out);
  for (const flag of EXTRA_OUT_FLAGS[command] ?? []) assertOutIsFile(values[flag], `--${flag}`);
}
