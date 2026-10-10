import { sha256 } from '../util/hash.mjs';
import { selectRunner, discoverRunnerManifest, OWNED_RUNNERS } from './runners/index.mjs';
import { createDiscoveryManifest, DiscoveryError } from './runners/discovery.mjs';

/** The same adapter/configuration universe used by probing, never a file-glob guess. */
export function hashNativeTestUniverse(manifests) {
  const entries = [...manifests];
  if (!entries.length) throw new DiscoveryError('a native test universe requires runner manifests');
  if (!entries.some(([, manifest]) => manifest?.files?.length)) throw new DiscoveryError('a native test universe must contain test files');
  const names = new Set();
  const bound = entries.map(([runner, manifest]) => {
    if (!runner?.name || names.has(runner.name) || !manifest?.runner) throw new DiscoveryError('native universe runner identities must be unique');
    names.add(runner.name);
    const canonical = createDiscoveryManifest({ runner: manifest.runner.name, version: manifest.runner.version, files: manifest.files, configFiles: manifest.configFiles, source: manifest.source });
    if (canonical.testUniverseHash !== manifest.testUniverseHash || runner.name !== manifest.runner.name) throw new DiscoveryError('native universe manifest binding is inconsistent');
    return { runner: runner.name, hash: manifest.testUniverseHash };
  }).sort((a, b) => a.runner.localeCompare(b.runner));
  return sha256(JSON.stringify(bound));
}

/**
 * A custom `--runner-cmd` has no native listing, so its universe is the static
 * file set — and the command itself. The files alone cannot tell a broken
 * command from the fixed one, and a verdict measured by one is not an answer
 * from the other. The parsed argv is hashed, so reformatting whitespace is not
 * a change and the command text never appears in the evidence.
 */
export function hashCustomCommandUniverse(files, commandTemplate) {
  return sha256(JSON.stringify({ schemaVersion: 2, source: 'custom-command-static', command: commandTemplate, files }));
}

/** Shared owning-adapter collection; check failures retain existing probe semantics. */
export async function collectOwnedManifests(runner, primaryManifest, { projectDir, sourceDir, python, budgetMs, budgetFor, assertOpen = () => {} }) {
  const owned = OWNED_RUNNERS.filter((r) => r !== runner
    && !(r.name === 'python' && ['python', 'pytest', 'unittest'].includes(runner.name)));
  const ownedChecked = new Map();
  const manifests = new Map(primaryManifest ? [[runner, primaryManifest]] : []);
  for (const r of owned) {
    const check = await r.check({ projectDir, sourceDir, python, budgetMs: budgetFor ? budgetFor() : budgetMs, budgetFor });
    assertOpen();
    ownedChecked.set(r, check);
    if (!check.ok) continue;
    manifests.set(r, await discoverRunnerManifest(r, check, projectDir, budgetFor ? budgetFor() : budgetMs));
    assertOpen();
  }
  return { owned, ownedChecked, manifests };
}

/** Fresh current-project collection for an explicitly requested policy boundary. */
export async function readNativeTestUniverse(options) {
  const selected = await selectRunner({ ...options, name: options.runnerName ?? 'auto' });
  options.assertOpen?.();
  if (selected.error) throw new DiscoveryError(selected.error);
  const collection = await collectOwnedManifests(selected.runner, selected.manifest, options);
  const primaryRunner = { name: selected.engine ?? selected.runner.name, version: selected.version };
  const runners = [primaryRunner, ...[...collection.ownedChecked].filter(([, check]) => check.ok).map(([runner, check]) => ({ name: check.engine ?? runner.name, version: check.version }))];
  return { ...collection, primary: selected.runner, primaryRunner, runners, testUniverseHash: hashNativeTestUniverse(collection.manifests) };
}
