import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { devNull } from 'node:os';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parseFixChangedPaths, parseFixProjectMarkers, validateFixProjectPrefix } from './fix-paths.mjs';
import { admitIntentProject } from './admission.mjs';

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_BYTES = 128 * 1024;
function refuse(reason) { throw new Error(`fix input refused: ${reason}`); }

function localFixContext({ projectDir, commit, budgetMs = 5000 }) {
  if (typeof commit !== 'string' || !OBJECT_ID.test(commit)) refuse('full-object-id-required');
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 5000) refuse('invalid-budget');
  const started = performance.now();
  const requestedRoot = resolve(projectDir);
  if (lstatSync(requestedRoot).isSymbolicLink()) refuse('unsafe-root');
  const root = realpathSync(requestedRoot);
  const identity = lstatSync(root);
  if (!identity.isDirectory()) refuse('unsafe-root');
  const checkRoot = () => {
    const current = lstatSync(requestedRoot);
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino || realpathSync(requestedRoot) !== root) refuse('root-changed');
  };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' });
  let captured = 0;
  const read = args => {
    checkRoot();
    const remaining = Math.floor(budgetMs - (performance.now() - started));
    if (remaining < 1) refuse('deadline');
    const run = spawnSync('git', ['--no-lazy-fetch', '--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`, ...args], {
      cwd: root, env, shell: false, timeout: remaining, maxBuffer: MAX_BYTES,
    });
    if (run.error || run.signal || run.status !== 0 || performance.now() - started >= budgetMs) refuse('object-read-unavailable');
    if (!Buffer.isBuffer(run.stdout) || run.stdout.length > MAX_BYTES) refuse('object-byte-limit');
    captured += run.stdout.length;
    if (captured > 512 * 1024) refuse('aggregate-byte-limit');
    checkRoot();
    return run.stdout;
  };
  const finish = () => {
    checkRoot();
    if (budgetMs <= performance.now() - started) refuse('deadline');
  };
  return { root, read, finish };
}

function commitMetadata(context, commit) {
  const bytes = context.read(['cat-file', 'commit', commit]);
  const hash = createHash(commit.length === 40 ? 'sha1' : 'sha256').update(`commit ${bytes.length}\0`).update(bytes).digest('hex');
  if (hash !== commit) refuse('object-identity-mismatch');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { refuse('invalid-utf8'); }
  if (text.includes('\0')) refuse('invalid-encoding');
  const separator = text.indexOf('\n\n');
  if (separator < 0) refuse('malformed-commit');
  const parents = text.slice(0, separator).split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  if (parents.length !== 1 || !OBJECT_ID.test(parents[0]) || parents[0].length !== commit.length) refuse('single-parent-required');
  const subject = text.slice(separator + 2).split('\n', 1)[0];
  if (Buffer.byteLength(subject) > 1024 || /[\x00-\x1f\x7f-\x9f]/.test(subject)) refuse('unsafe-subject');
  return Object.freeze({ commit, parent: parents[0], subject });
}

/** Local immutable metadata, not a bug claim or an authenticated intent source. */
export function readFixCommitMetadata(options) {
  const context = localFixContext(options);
  const metadata = commitMetadata(context, options.commit);
  context.finish();
  return metadata;
}

/** Complete bounded historical diff for an exact worktree root, not current source authority. */
export function readFixCommitInventory(options) { return fixInventory(options, false); }

/** Explicit selected nested project; historical inventory is not current source authority. */
export function readNestedFixCommitInventory(options) { return fixInventory(options, true); }

/** Observe root/nested selection once, under one unchanged offline Git context. */
export function readScopedFixCommitInventory(options) { return fixInventory(options, 'selected'); }

function fixInventory(options, mode) {
  const context = localFixContext(options);
  let toplevel;
  try { toplevel = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(context.read(['rev-parse', '--show-toplevel'])); }
  catch (error) { if (error instanceof TypeError) refuse('invalid-root-encoding'); throw error; }
  const scoped = mode === 'selected';
  const nested = scoped ? toplevel.endsWith('\n') && toplevel.slice(0, -1) !== context.root : mode;
  let projectPrefix = '', selected;
  if (!nested) {
    if (!toplevel.endsWith('\n') || toplevel.slice(0, -1) !== context.root) refuse('project-root-required');
  } else {
    if (!toplevel.endsWith('\n')) refuse('project-root-required');
    const repositoryRoot = realpathSync(toplevel.slice(0, -1));
    const prefix = relative(repositoryRoot, context.root);
    if (!prefix) refuse('nested-project-required');
    if (isAbsolute(prefix) || prefix === '..' || prefix.startsWith(`..${sep}`)) refuse('outside-project');
    projectPrefix = validateFixProjectPrefix(prefix.split(sep).join('/'));
    selected = admitIntentProject({ projectDir: context.root });
  }
  const metadata = commitMetadata(context, options.commit);
  const tree = id => context.read(['ls-tree', '-r', '--name-only', '-z', '--full-tree', id]);
  const projects = parseFixProjectMarkers(tree(metadata.parent), tree(metadata.commit), { projectPrefix });
  const args = ['diff-tree', '--raw', '--no-abbrev', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '-r', '--no-commit-id', metadata.parent, metadata.commit, '--'];
  if (projectPrefix) args.push(`:(top,literal)${projectPrefix}/`);
  const raw = context.read(args);
  const inventory = parseFixChangedPaths(raw, { nestedProjects: projects, objectIdWidth: metadata.commit.length, projectPrefix });
  if (selected) {
    const current = admitIntentProject({ projectDir: context.root });
    if (current.projectDir !== selected.projectDir || current.marker.hash !== selected.marker.hash ||
      Object.entries(selected.marker.identity).some(([key, value]) => current.marker.identity[key] !== value)) refuse('project-marker-changed');
  }
  context.finish();
  if (scoped) return Object.freeze({ scope: projectPrefix ? 'selected-nested-project' : 'project-root', ...metadata, ...inventory });
  return Object.freeze({ ...metadata, ...inventory });
}
