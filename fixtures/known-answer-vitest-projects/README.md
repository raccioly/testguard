# Known-answer fixture: vitest `test.projects`

A vitest configuration with three projects (`vitest.config.mjs`):

- `ui` lists `tests/ui/` and `tests/shared/`, with `WHICH=ui`;
- `node` lists `tests/shared/`, with `WHICH=node`;
- `legacy` lists `legacy/`, whose `legacy/tests/ui/round.test.mjs` path contains
  the ui test path `tests/ui/round.test.mjs`.

`vitest list` names each file's project. A defender runs under every project
that lists it, each run selected with `--project`, and the runs merge
pessimistically. The three claims test exactly that:

| Claim | Expected | What it proves |
|---|---|---|
| `PROJECT-UI-ADULT-BOUNDARY` | killed | a file listed under one project runs there |
| `PROJECT-SHARED-NODE-GREETING` | killed | a file listed under two projects runs under both: only the `node` run fails |
| `PROJECT-UI-ROUNDS-HALF-UP` | survived | `--project` keeps another project's matching file out of the defender's run |

Every verdict in `expected.json` was verified by hand: apply the fault, run
`vitest run <file> --project=<name>` for each listed project.
