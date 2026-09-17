# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ current |

## Reporting a vulnerability

1. **Do not** open a public issue for a security problem.
2. Report privately via [GitHub Security Advisories](https://github.com/raccioly/testguard/security/advisories/new).
3. Include a description, steps to reproduce, impact, and a suggested fix if you have one.

You will get an acknowledgement within 48 hours and a timeline for a fix.

## Security model

TestGuard is a local CLI with a deliberately small surface:

- **One runtime dependency, exact-pinned:** `ajv`, which validates every
  document the tool reads or writes against the spec. Install scripts are
  disabled (`.npmrc`). `vitest` is development-only.
- **No network access.** Nothing is uploaded, fetched, or reported anywhere.
- **No credentials.** There is nothing to authenticate to.
- **Writes are confined** to `.testguard/` in the probed project and to
  scratch git worktrees under the system temp directory, which are removed
  after each run. With `--in-place`, the mutated files are restored — on
  success, on failure, and on `SIGINT`/`SIGTERM`.
- **Publishing uses OIDC Trusted Publishing** to npm and PyPI. The release
  pipeline holds no long-lived tokens; npm provenance attestations are
  generated automatically.

## The claims file is code

`testguard.claims.json` contains `replace` strings that are written into
your source and then executed by **your** test runner, inside a worktree of
**your** repository. Treat the file exactly as you treat source:

- Review changes to it in pull requests.
- In CI, a pull request that edits the claims file has the same power as a
  pull request that edits a test — no more, no less. Do not run `probe` on
  untrusted pull requests with secrets in the environment, for the same
  reason you would not run their tests that way.
- The schema rejects absolute paths and `..` traversal in fault targets, so a
  fault cannot address files outside the probed project.

## For users

- Keep Node.js ≥ 20 and current.
- Prefer the default worktree mode; use `--in-place` only when you need
  uncommitted changes probed.
- Read `.testguard/evidence.json` before sharing it: it contains file paths,
  test names, and content hashes of your project.
