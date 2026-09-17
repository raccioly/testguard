import * as vitest from './vitest.mjs';
import * as jest from './jest.mjs';

export const RUNNERS = { vitest, jest };

/**
 * Pick the runner: an explicit name, or the first of vitest, jest that is
 * resolvable from the project. Returns { runner, version } or { error }.
 */
export async function selectRunner({ projectDir, name = 'auto' }) {
  const candidates = name === 'auto' ? [vitest, jest] : [RUNNERS[name]];
  if (!candidates[0]) return { error: `unknown runner "${name}"; use vitest, jest or auto` };
  const messages = [];
  for (const r of candidates) {
    const c = await r.check({ projectDir });
    if (c.ok) return { runner: r, version: c.version, source: c.source };
    messages.push(`${r.name}: ${c.message}`);
  }
  return { error: messages.join('; ') };
}
