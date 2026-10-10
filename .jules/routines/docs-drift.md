# Routine: docs-drift (weekly)

Check what the user docs say about one subcommand against what the CLI
actually does, and fix the docs where they are wrong.

Follow `.jules/RULES.md` throughout.

## Steps

1. Run `node .jules/preflight.mjs docs-drift`. On STOP, end the task. On GO,
   the `target:` line is the one subcommand you check.
2. Read the truth from the CLI: `node cli/testguard.mjs --help`, and the
   subcommand's own section of it.
3. Find every mention of that subcommand in `README.md` and `docs/**/*.md`.
4. A drift is any of these:
   - a flag the docs describe that the CLI does not accept;
   - a flag whose meaning or default the docs state differently from `--help`;
   - an example command for this subcommand that fails or behaves differently
     when you run it. Run it on a copy of `fixtures/known-answer` in a
     temporary directory.

   These are **not** drift:
   - wording or style;
   - counts of tests, claims or faults;
   - version numbers and links;
   - a feature the CLI does not have. That is a feature request; mention it in
     the summary.
5. If you found no drift, end the task with no pull request.
6. Where the docs are wrong, fix the docs.
   - Edit only `README.md` and `docs/**/*.md`.
   - In translated docs, fix only the same wrong flag or value.
   - Where the docs are right and the CLI is wrong, that is a bug: change
     nothing, and describe it in the task summary.
7. Run the checks in `.jules/RULES.md` §4, plus
   `npx -y docguard-cli@0.41.5 guard`, then open the pull request.

A docs-only change merges on a green CI without a maintainer.
