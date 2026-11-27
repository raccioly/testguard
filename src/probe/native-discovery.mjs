/**
 * Runner-native defender discovery (#334, layer 2).
 *
 * The static layer reads imports, tsconfig `paths`, vite aliases and a literal
 * Jest `moduleNameMapper`. It cannot read a custom `resolver`, `modulePaths`, a
 * preset (the Salesforce LWC one maps every `c/<name>`) or a mapper that is
 * computed: a test that imports something through one of those is
 * `indeterminate`, never absent. For such a test only the runner knows the
 * answer, so ask it: Jest lists the tests that reach a file
 * (`--listTests --json --findRelatedTests <file>`), resolving with the
 * project's own configuration.
 *
 * What the answer may and may not do:
 * - It resolves only candidates that were indeterminate because a specifier
 *   would not resolve. A computed specifier, a parse failure or a graph limit
 *   is not something Jest's answer settles; those stay indeterminate.
 * - A candidate Jest lists is a defender (found by `runner-native`); one it
 *   does not list is related to nothing the runner can see, and leaves the
 *   indeterminate set. A run that fails, times out, is cut by the run limit or
 *   prints something unreadable resolves nothing: the candidates stay
 *   indeterminate and say why. Uncertainty never becomes `nocover`.
 * - A listed test that mocks a module through a name no static rule can place
 *   might be mocking the subject itself, so it stays indeterminate too.
 * - Only files inside the project, and inside the configured test universe,
 *   count.
 *
 * Answers are cached per (target, discovery-config hash): parallel fan-out and
 * every fault on one file share one process, and an edit to anything the
 * configuration reads is a new question. The number of processes is bounded.
 */
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { DISCOVERY_TIMEOUT_MS } from './runners/discovery.mjs';
import { classifyDefenders, mockSpecifiers } from './mocks.mjs';

/** At most this many Jest processes per probe run; the target past it stays indeterminate. */
export const NATIVE_MAX_RUNS = 64;

const RESOLUTION_CODES = new Set(['unreadable-module', 'ambiguous-resolution']);
/** Indeterminate only because a specifier would not resolve: the one thing the runner can settle. */
const resolutionOnly = (entry) => entry.issues?.length > 0
  && entry.issues.every((issue) => RESOLUTION_CODES.has(issue.code) && typeof issue.specifier === 'string');

const packageName = (specifier) => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
const BUILTINS = new Set(builtinModules);

/** Could `jest.mock(specifier)` replace the subject without any static rule being able to say so? */
function mocksAnUnplacedName(projectDir, testRel) {
  let source;
  try { source = readFileSync(join(projectDir, testRel), 'utf8'); } catch { return true; }
  return mockSpecifiers(source).some(({ specifier }) => {
    if (specifier.startsWith('.') || specifier.startsWith('node:') || BUILTINS.has(specifier)) return false;
    // An installed package is not project source; anything else is a name only the runner can place.
    return !isInstalled(projectDir, packageName(specifier));
  });
}
function isInstalled(projectDir, name) {
  try { readFileSync(join(projectDir, 'node_modules', name, 'package.json')); return true; } catch { return false; }
}

const text = (error) => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 300);

/**
 * `runner` is the project runner's adapter; one without `relatedTests` is never
 * asked. `resolve(detailed, targetRel, universe)` returns `detailed` when there
 * is nothing to ask, else a copy with the answer applied. A result that used
 * the runner carries `discovery: { engine: 'runner-native', runner, files }`.
 */
export function createNativeDiscovery({ runner, projectDir, timeoutMs = DISCOVERY_TIMEOUT_MS, maxRuns = NATIVE_MAX_RUNS, env, onNote } = {}) {
  const answers = new Map();
  let runs = 0;

  const ask = (targetRel) => {
    let key;
    try {
      key = `${runner.discoveryConfigHash(projectDir)}\0${targetRel}`;
    } catch (error) {
      return Promise.resolve({ ok: false, reason: `the discovery configuration could not be hashed (${text(error)})` });
    }
    if (!answers.has(key)) {
      if (runs >= maxRuns) {
        answers.set(key, Promise.resolve({ ok: false, reason: `the run limit (${maxRuns} ${runner.name} processes per probe) was reached` }));
      } else {
        runs++;
        answers.set(key, runner.relatedTests({ projectDir, target: targetRel, timeoutMs, ...(env ? { env } : {}) }).then(
          (files) => {
            onNote?.(`${targetRel}: ${runner.name} lists ${files.length} related test file${files.length === 1 ? '' : 's'} (discovery: runner-native)`);
            return { ok: true, files: new Set(files) };
          },
          (error) => ({ ok: false, reason: text(error) }),
        ));
      }
    }
    return answers.get(key);
  };

  return {
    async resolve(detailed, targetRel, universe) {
      if (typeof runner?.relatedTests !== 'function' || typeof runner.discoveryConfigHash !== 'function') return detailed;
      if (!detailed.indeterminate.some(resolutionOnly)) return detailed;
      const answer = await ask(targetRel);
      if (!answer.ok) {
        return {
          ...detailed,
          indeterminate: detailed.indeterminate.map((entry) => (resolutionOnly(entry)
            ? { ...entry, reason: `${entry.reason ?? 'unknown'}; runner-native discovery (${runner.name} --findRelatedTests) gave no answer: ${answer.reason}` }
            : entry)),
        };
      }
      const inUniverse = universe ? new Set(universe) : null;
      const found = [];
      const remaining = [];
      for (const entry of detailed.indeterminate) {
        if (!resolutionOnly(entry)) { remaining.push(entry); continue; }
        if (!answer.files.has(entry.file) || (inUniverse && !inUniverse.has(entry.file))) continue; // answered: not related
        if (mocksAnUnplacedName(projectDir, entry.file)) {
          remaining.push({ ...entry, reason: `${entry.reason ?? 'unknown'}; runner-native discovery lists it, but it mocks a module no static rule can place` });
          continue;
        }
        found.push(entry.file);
      }
      const importing = [...new Set([...detailed.importing, ...found])].sort();
      return {
        ...detailed,
        importing,
        ...classifyDefenders(projectDir, targetRel, importing, detailed.relations),
        indeterminate: remaining,
        ...(found.length ? { discovery: { engine: 'runner-native', runner: runner.name, files: found.sort() } } : {}),
      };
    },
  };
}
