/**
 * The files a closure may count as the project's (#272): what git tracks,
 * plus — when the run snapshots the working tree (`--include-dirty`) —
 * untracked files git does not ignore. Exactly what the scratch worktree will
 * contain, so a closure computed on the working tree (`probe --changed`,
 * `status`, `gate`, the origin-policy freshness check) and one computed in the
 * scratch tree describe the same tree. An ignored directory (a deployment
 * bundle with copies of third-party packages, a vendored build) is never a
 * project file: indexed, its copies turned `import pydantic` into a project
 * import and made every closure indeterminate.
 *
 * null when `projectDir` is not inside a git work tree: then there is no
 * commit to agree with, and every file on disk counts, as before.
 */
import { spawnSync } from 'node:child_process';

export function visibleFiles(projectDir, { untracked = false } = {}) {
  const args = ['-c', 'core.quotepath=off', 'ls-files', '-z', '--cached', ...(untracked ? ['--others', '--exclude-standard'] : []), '--', '.'];
  const r = spawnSync('git', args, { cwd: projectDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (r.status !== 0 || r.error) return null;
  const files = r.stdout.split('\0').filter(Boolean);
  // Nothing tracked yet: there is no commit to agree with.
  return files.length ? new Set(files) : null;
}
