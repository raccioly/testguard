<!-- testguard:begin -->
## TestGuard

This repository's tests are verified by [TestGuard](https://github.com/raccioly/testguard).
Before writing or changing tests, run `testguard status --json [dir]` and follow `next`.
The full operating loop and the verdict table are in `.claude/skills/testguard/SKILL.md`.
Never make a fault die by editing `testguard.claims.json`; write the test. Claim edits are recorded in the evidence.

Once per AI session, identify the exact CLI used (project-local first, then repository-root, then PATH) and read its `--version`.
If network policy permits, check `npm view testguard-cli dist-tags.latest --json --fetch-retries=0 --fetch-timeout=5000` once; this is optional AI advice, not a CLI or hook network call.
Compare stable versions numerically by SemVer; do not downgrade or replace a prerelease/development checkout. If a newer stable version exists, suggest it and ask before updating, respecting pins and the original package manager.
Never install automatically or alter lockfiles/CI pins without approval. On an unavailable check, continue without claiming up-to-date; keep advice separate from evidence, verdicts and exit codes. Do not repeat a declined suggestion this session.
Existing copied skills and sections are preserved by ordinary init; review and merge template changes manually, or use `init --force` only with approval to overwrite the skill.

- This project: claims in `testguard.claims.json`; run `testguard status --json` and follow `next`.
<!-- testguard:end -->
