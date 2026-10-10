import { resolve } from 'node:path';
import { loadConcerns, renderConcerns } from '../supply/concerns.mjs';

/**
 * `testguard concerns [dir]`: the one-sentence scopes a sweep can be aimed by.
 *
 * A concern says WHERE to look and WHICH shapes of break are relevant. It is
 * never a promise about the code — only a claim is that — so this command
 * validates and lists, and has no exit code that means "something is wrong
 * with your project". Exit 2 is a malformed concerns file, which is wrong with
 * the FILE.
 */
export async function concernsCommand({ projectDir, values, version }, io) {
  const path = values.concerns ? resolve(values.concerns) : undefined;
  // A file that does not parse or does not conform throws a SpecDocError
  // naming it, which the CLI reports as exit 2: wrong with the FILE.
  const loaded = loadConcerns(projectDir, { path });
  if (values.json) {
    io.out(JSON.stringify({ schemaVersion: 1, tool: { name: 'testguard', version }, source: loaded.source, shadowed: loaded.shadowed, concerns: loaded.concerns }, null, 2));
  } else {
    io.out(renderConcerns(loaded));
  }
  return 0;
}
