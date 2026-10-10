# TestGuard documentation

TestGuard breaks your code on purpose and reports every promise your tests did
not notice breaking. These pages take you from a first run to a gate in CI,
whether you are starting a project or adding TestGuard to one that already
has thousands of tests. The [README](../README.md) is the one-page overview;
everything below goes deeper.

## Start here

| If you want to | Read |
|---|---|
| See it work in ten minutes | [Quickstart](quickstart.md) |
| Install it with npm, pip, Homebrew, a GitHub Action, pre-commit or GitLab CI | [Installation](installation.md) |
| Add it to a codebase that already has tests | [Adopting TestGuard in an existing project](guides/existing-projects.md) |
| Start a new project with it from the first commit | [New projects](guides/new-projects.md) |
| Check whether your language and test runner are supported | [Languages and runners](reference/languages-and-runners.md) |
| Understand the idea before installing anything | [How it works](concepts/how-it-works.md) |

## Guides

Task-oriented pages: one goal each, with the commands in order.

- [Adopting TestGuard in an existing project](guides/existing-projects.md): gate the delta, claim the risky surface, baseline the rest
- [New projects](guides/new-projects.md): claims before code
- [Writing claims](guides/writing-claims.md): claims, faults, anchors, `scaffold`, concerns and `admit`
- [AI agents](guides/ai-agents.md): Claude Code, Codex, Cursor and any MCP or shell-capable harness
- [Python projects](guides/python.md): pytest and `unittest`, interpreters, `patch()` and editable installs
- [Monorepos](guides/monorepo.md): nested projects, shared `node_modules`, per-package CI
- [Performance](guides/performance.md): what a probe costs, slow gates, workers and budgets
- [Replaying escaped bugs](guides/replay.md): would this suite have caught the bugs that already shipped?
- CI: [GitHub Actions](guides/ci/github-actions.md) · [GitLab CI](guides/ci/gitlab.md) · [pre-commit](guides/ci/pre-commit.md)
- [Upgrading](upgrade.md): new versions, the copied skill and existing baselines

## Reference

Exact facts, checked against the code by `test/docs.test.mjs`.

- [CLI](reference/cli.md): every command, every flag, exit codes
- [Languages and runners](reference/languages-and-runners.md): the support matrix
- [Configuration](reference/configuration.md): `testguard.claims.json`, `testguard.ignore.json`, concerns and environment variables
- [Verdicts](reference/verdicts.md): what each result means and the one acceptable fix
- [Artifacts](reference/artifacts.md): every file TestGuard writes, what to commit, and the JSON Schemas
- [MCP server](reference/mcp.md): the read-only tools for agent harnesses
- [GATE-SEMANTICS.md](../spec/GATE-SEMANTICS.md): the normative rules for when CI goes red

## Understanding

- [How it works](concepts/how-it-works.md): the loop, isolation, confirmation and what TestGuard is not
- [Glossary](glossary.md): every term in one place
- [FAQ](faq.md)
- [Troubleshooting](troubleshooting.md): the message you saw, why, and what to do
- [Prior art](../docs-canonical/PRIOR-ART.md): what was taken from Google's and Meta's mutation work, and what was not
- [Technical brief (PDF)](testguard-explained.pdf): six pages, from the idea to the field evidence

## Translations

The README and the quickstart are translated. English is authoritative; each
translation names the release it was translated from, and its commands and
output are the English blocks, unchanged.

| Language | README | Quickstart |
|---|---|---|
| Português (Brasil) | [README](i18n/pt-BR/README.md) | [Início rápido](i18n/pt-BR/quickstart.md) |
| Español | [README](i18n/es/README.md) | [Inicio rápido](i18n/es/quickstart.md) |
| 简体中文 | [README](i18n/zh-CN/README.md) | [快速上手](i18n/zh-CN/quickstart.md) |

## Contributing to the docs

A page that is wrong is a bug. [Open a documentation issue](https://github.com/raccioly/testguard/issues/new?template=documentation.md)
or send a pull request; see [CONTRIBUTING.md](../CONTRIBUTING.md). Every
command, flag and file name on these pages must match the code, and
`npm test` fails when a CLI command, a runner, a CI input, a verdict or a
status state is missing from its reference page, or when a link breaks.
