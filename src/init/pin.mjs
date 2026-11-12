/**
 * What `init` does so a project runs the TestGuard it reviewed (#293): an
 * exact-pinned devDependency, and a dependency-update rule so a new release
 * arrives as a pull request the project's own CI gates, never by itself.
 *
 * Pure text in, text out: the caller reads and writes the files.
 */

export const PACKAGE = 'testguard-cli';
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
/** Specs that resolve to whatever is newest when installed: a floating version. */
export const isFloatingSpec = (spec) => ['latest', 'next', '*', 'x', ''].includes(String(spec).trim());

/**
 * `package.json` with `testguard-cli` pinned to exactly `version` in
 * devDependencies. Present in any form, it is left alone and described:
 * `exact`, `floating` (latest, *, …: a finding) or `range` (^, ~: the lockfile
 * pins it, a fresh install does not).
 */
export function pinDevDependency(text, version) {
  if (!EXACT.test(version ?? '')) throw new TypeError(`an exact version is pinned, not ${JSON.stringify(version)}`);
  const pkg = JSON.parse(text);
  const spec = pkg.devDependencies?.[PACKAGE] ?? pkg.dependencies?.[PACKAGE] ?? pkg.optionalDependencies?.[PACKAGE];
  if (spec !== undefined) {
    return { action: EXACT.test(spec) ? 'exact' : isFloatingSpec(spec) ? 'floating' : 'range', spec };
  }
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  pkg.devDependencies = { ...(pkg.devDependencies ?? {}), [PACKAGE]: version };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { action: 'added', spec: version, text: JSON.stringify(pkg, null, indent).replace(/\n/g, eol) + (text.endsWith('\n') ? eol : '') };
}

const dependabotEntry = (directory) => `  - package-ecosystem: npm
    directory: ${directory}
    schedule:
      interval: weekly
    # TestGuard (#293): new releases arrive as pull requests gated by CI.
    allow:
      - dependency-name: ${PACKAGE}
    groups:
      testguard:
        patterns:
          - ${PACKAGE}
`;

/** The Dependabot directory for a project at `dir` (relative to the repository root). */
export const dependabotDirectory = (dir) => (dir === '.' ? '/' : `/${dir}`);

/**
 * `.github/dependabot.yml` with an update rule for testguard-cli. Written when
 * absent; an entry appended when the file has no npm rule at all and ends in
 * its `updates:` list. A file with an npm rule already is not edited (a second
 * npm rule for one directory is a configuration error to Dependabot): the
 * caller reports the lines to add to it. One that names testguard-cli is left.
 */
export function dependabotRule(existing, dir) {
  const directory = dependabotDirectory(dir);
  if (existing === undefined) return { action: 'created', text: `version: 2\nupdates:\n${dependabotEntry(directory)}` };
  if (existing.includes(PACKAGE)) return { action: 'present' };
  const npm = /package-ecosystem:\s*["']?npm["']?\s*$/m.test(existing);
  const lines = existing.replace(/\s+$/, '').split('\n');
  const lastTop = [...lines].reverse().find((l) => /^\S/.test(l) && !l.startsWith('#'));
  if (!npm && lastTop && /^updates:\s*$/.test(lastTop)) return { action: 'appended', text: `${existing.replace(/\s*$/, '\n')}${dependabotEntry(directory)}` };
  return { action: 'manual', snippet: npm ? `groups:\n  testguard:\n    patterns:\n      - ${PACKAGE}` : dependabotEntry(directory) };
}

/** Renovate config files `init` can read as JSON, in Renovate's own lookup order. */
export const RENOVATE_JSON = ['renovate.json', '.github/renovate.json', '.gitlab/renovate.json', '.renovaterc', '.renovaterc.json'];
/** Renovate config files that are not plain JSON: reported, never edited. */
export const RENOVATE_OTHER = ['renovate.json5', '.github/renovate.json5', '.gitlab/renovate.json5', '.renovaterc.json5'];

/** A Renovate config (JSON text) with a package rule that groups and pins testguard-cli. */
export function renovateRule(text) {
  const config = JSON.parse(text);
  const rules = Array.isArray(config.packageRules) ? config.packageRules : [];
  if (rules.some((r) => [r.matchPackageNames, r.matchPackagePatterns, r.packageNames].some((names) => Array.isArray(names) && names.includes(PACKAGE)))) return { action: 'present' };
  config.packageRules = [...rules, { matchPackageNames: [PACKAGE], groupName: 'testguard', rangeStrategy: 'pin' }];
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  return { action: 'extended', text: JSON.stringify(config, null, indent) + '\n' };
}
