import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

// `.py` belongs here for the same reason every other extension does: a file
// the gate does not recognise as source is excluded as `non-source`, which
// means a changed Python file could never be reported as uncovered and the
// gate would pass while saying nothing.
export const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.py']);

/**
 * Source TestGuard recognizes but cannot probe yet (#331). A changed file in
 * one of these languages is a reported gap, never `non-source`: the gate would
 * otherwise print "every changed source file carries a claim" over code it
 * never looked at. The table is also the list of languages still to support;
 * when a runner adapter lands, the language moves to `SOURCE_EXT`.
 * `match` takes a repo-relative path with forward slashes.
 */
const byExt = (...exts) => (file) => exts.some((e) => file.endsWith(e));
export const KNOWN_SOURCE = Object.freeze([
  { id: 'apex', name: 'Apex', match: byExt('.cls', '.trigger') },
  { id: 'scala', name: 'Scala', match: byExt('.scala') },
  { id: 'csharp', name: 'C#', match: byExt('.cs') },
  { id: 'go', name: 'Go', match: byExt('.go') },
  { id: 'ruby', name: 'Ruby', match: byExt('.rb') },
  { id: 'php', name: 'PHP', match: byExt('.php') },
  { id: 'dataweave', name: 'DataWeave', match: byExt('.dwl') },
  { id: 'salesforce-flow', name: 'Salesforce Flow', match: byExt('.flow-meta.xml') },
  { id: 'mule-xml', name: 'Mule XML', match: (file) => file.endsWith('.xml') && /(^|\/)src\/main\/mule\//.test(file) },
]);

/**
 * Source a built-in runner adapter makes probeable, but only where the project
 * has that adapter's build file (#329). The gate runs with no runner selected,
 * so the project decides: a `pom.xml` or a Gradle build file in the directory
 * of the file, or in any directory above it up to the project, says `maven` or
 * `gradle` can run it. With no such file the language is a reported gap, as
 * before. Each entry names the adapters and the build files that select them;
 * the conformance test holds the adapters' `extensions` to this table.
 */
export const BUILD_MARKERS = Object.freeze({
  maven: Object.freeze(['pom.xml']),
  gradle: Object.freeze(['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']),
});
export const BUILD_SOURCE = Object.freeze([
  { id: 'java', name: 'Java', match: byExt('.java'), runners: Object.freeze(['maven', 'gradle']) },
  { id: 'kotlin', name: 'Kotlin', match: byExt('.kt'), runners: Object.freeze(['maven', 'gradle']) },
]);

const gap = (hit) => ({ id: hit.id, name: hit.name });

/** The known language of a path that TestGuard cannot probe without a build file, or null. Pure. */
export const unsupportedLanguage = (file) => {
  if (SOURCE_EXT.has(extname(file))) return null;
  const hit = KNOWN_SOURCE.find((l) => l.match(file)) ?? BUILD_SOURCE.find((l) => l.match(file));
  return hit ? gap(hit) : null;
};

/**
 * What a project makes probeable. `probeable(file)`: source TestGuard can run
 * here. `unsupported(file)`: the language gap, or null. `runnersFor(file)`: the
 * build-system adapters whose build file is in the project, in table order.
 * Directory lookups are cached for the life of the classifier only, so build
 * one per measurement and never keep it.
 */
export function sourceClassifier(projectDir) {
  const markers = new Map();
  const runnersIn = (dir) => {
    if (!markers.has(dir)) {
      markers.set(dir, Object.entries(BUILD_MARKERS).filter(([, names]) => names.some((n) => existsSync(join(projectDir, dir, n)))).map(([runner]) => runner));
    }
    return markers.get(dir);
  };
  const runnersFor = (file) => {
    const language = BUILD_SOURCE.find((l) => l.match(file));
    if (!language) return [];
    const found = new Set();
    for (let dir = dirname(file); ; dir = dirname(dir)) {
      for (const runner of runnersIn(dir === '.' ? '' : dir)) found.add(runner);
      if (dir === '.' || dir === '/' || dir === '') break;
    }
    return language.runners.filter((runner) => found.has(runner));
  };
  const probeable = (file) => SOURCE_EXT.has(extname(file)) || runnersFor(file).length > 0;
  const unsupported = (file) => (probeable(file) ? null : unsupportedLanguage(file));
  return { probeable, unsupported, runnersFor };
}

export const languageName = (id) => KNOWN_SOURCE.find((l) => l.id === id)?.name ?? BUILD_SOURCE.find((l) => l.id === id)?.name ?? id;

/** `{ total, byLanguage }` over language ids, or undefined for none. Ids sort for a stable document. */
export const tallyLanguages = (ids) => {
  if (!ids.length) return undefined;
  const byLanguage = {};
  for (const id of [...ids].sort()) byLanguage[id] = (byLanguage[id] ?? 0) + 1;
  return { total: ids.length, byLanguage };
};

/** "Apex 3, Java 1": largest first, name order on ties. */
export const describeLanguages = ({ byLanguage }) => Object.entries(byLanguage)
  .sort((a, b) => b[1] - a[1] || languageName(a[0]).localeCompare(languageName(b[0])))
  .map(([id, n]) => `${languageName(id)} ${n}`).join(', ');
