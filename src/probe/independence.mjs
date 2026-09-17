import { git, GitError } from '../git.mjs';

/**
 * Maturity-ladder L3: independence.
 *
 * `probe` measures POWER — would this test notice if the code were wrong.
 * It says nothing about who wrote the test. An agent that writes the code and
 * its defender in one change encodes whatever it believed, and a kill by such
 * a test is weaker evidence than a kill by a test written separately
 * (SpecBench: agents saturate the tests they can see).
 *
 * This is a SIGNAL, never a verdict. A co-authored kill is legitimate — a bug
 * fix *should* ship with its regression test — but a repository where every
 * kill is co-authored has no independent verification, whatever its claim
 * verification rate says. Ranking may read it; `classify()` never does.
 */
const CLASSES = ['co-authored', 'separate-change', 'unknown'];

/** `git log -1` for one path at a commit → {commit, author} or null when there is no history for it. */
function lastCommit(dir, ref, path) {
  try {
    const out = git(['log', '-1', '--format=%H%x09%ae', ref, '--', path], dir);
    if (!out) return null;
    const [commit, author] = out.split('\t');
    return commit && author ? { commit, author } : null;
  } catch (e) {
    if (e instanceof GitError) return null;
    throw e;
  }
}

/**
 * Was the killing defender last touched by the same change as the fault's
 * target? `defenders` are the files whose tests failed on the fault.
 *
 * `co-authored`     — same commit, or the same author identity within the
 *                     commits the caller considers one change (`range`).
 * `separate-change` — different commits by different identities.
 * `unknown`         — no history for one of them: a working-tree snapshot of
 *                     untracked files, a shallow clone, or no commits.
 */
export function classifyIndependence({ dir, ref = 'HEAD', targetFile, defenders = [] }) {
  const target = lastCommit(dir, ref, targetFile);
  if (!target || defenders.length === 0) return { class: 'unknown' };

  let sameAuthor = false;
  let worst = null; // the most independent defender decides: one separate author is independence
  for (const d of defenders) {
    const def = lastCommit(dir, ref, d);
    if (!def) return { class: 'unknown', targetCommit: target.commit };
    const co = def.commit === target.commit || def.author === target.author;
    if (def.author === target.author) sameAuthor = true;
    if (!co) return { class: 'separate-change', defenderCommit: def.commit, targetCommit: target.commit, sameAuthor: false };
    worst ??= def;
  }
  return { class: 'co-authored', defenderCommit: worst.commit, targetCommit: target.commit, sameAuthor };
}

export { CLASSES as INDEPENDENCE_CLASSES };
