# Privacy

TestGuard collects nothing and sends nothing.

- **No telemetry.** There is no usage reporting, no crash reporting, no
  update check.
- **No network calls.** The CLI never opens a socket. The only network
  activity in the project is `npm install` fetching development dependencies
  and, if you use `npx`, npm fetching the package itself. The `pip` wrapper
  runs a project-local install when there is one and otherwise asks `npx` for
  the npm release matching the pip package's own version, which is that same
  fetch.
- **CI jobs you configure.** The GitLab template posts the brief as a
  merge-request note only when you set `post_note: true` and supply a token.
  The GitHub Action uploads nothing; publishing its evidence is a step you add.
- **What it writes locally:** `.testguard/evidence.json`, `baseline.json` and
  `brief.json` in the probed project. These contain repository-relative file
  paths, test file names, claim statements you wrote, SHA-256 content hashes,
  test counts and durations, and the git commit sha. They contain no source
  code and no test output beyond counts.
- **Scratch worktrees** are created under the system temp directory and
  removed when a run ends.

If you publish evidence files (for instance as CI artifacts), you are
publishing the information above. Review them first.
