# Privacy

TestGuard collects nothing and sends nothing.

- **No telemetry.** There is no usage reporting, no crash reporting, and no
  update check.
- **No network calls.** The CLI never opens a socket. The only network
  activity in the project is `npm install` fetching development dependencies.
  If you use `npx`, npm also fetches the package itself. The `pip` wrapper
  runs a project-local install when there is one. Otherwise it asks `npx` for
  the npm release that matches the pip package's own version. That is the same
  fetch.
- **CI jobs you configure.** The GitLab template posts the brief as a
  merge-request note only when you set `post_note: true` and supply a token.
  The GitHub Action uploads nothing. Publishing its evidence is a step you add.
- **What it writes locally:** `.testguard/evidence.json`, `baseline.json` and
  `brief.json` in the probed project. These files contain repository-relative
  file paths, test file names, claim statements you wrote, SHA-256 content
  hashes, test counts and durations, and the git commit sha. They contain no
  source code. They contain no test output except counts.
- **Scratch worktrees** are created under the system temp directory. TestGuard
  removes them when a run ends.

If you publish evidence files (for example as CI artifacts), you publish the
information above. Review the files first.
