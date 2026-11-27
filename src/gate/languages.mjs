import { extname } from 'node:path';

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
  { id: 'java', name: 'Java', match: byExt('.java') },
  { id: 'kotlin', name: 'Kotlin', match: byExt('.kt') },
  { id: 'scala', name: 'Scala', match: byExt('.scala') },
  { id: 'csharp', name: 'C#', match: byExt('.cs') },
  { id: 'go', name: 'Go', match: byExt('.go') },
  { id: 'ruby', name: 'Ruby', match: byExt('.rb') },
  { id: 'php', name: 'PHP', match: byExt('.php') },
  { id: 'dataweave', name: 'DataWeave', match: byExt('.dwl') },
  { id: 'salesforce-flow', name: 'Salesforce Flow', match: byExt('.flow-meta.xml') },
  { id: 'mule-xml', name: 'Mule XML', match: (file) => file.endsWith('.xml') && /(^|\/)src\/main\/mule\//.test(file) },
]);

/** The known-but-unprobeable language of a path, or null. Pure. */
export const unsupportedLanguage = (file) => {
  if (SOURCE_EXT.has(extname(file))) return null;
  const hit = KNOWN_SOURCE.find((l) => l.match(file));
  return hit ? { id: hit.id, name: hit.name } : null;
};

export const languageName = (id) => KNOWN_SOURCE.find((l) => l.id === id)?.name ?? id;

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
