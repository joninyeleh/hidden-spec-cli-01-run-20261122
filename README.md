# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/joninyeleh/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/joninyeleh/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a command-line tool that applies AI-written edits to a tree of text files: unified diffs (often with
wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. Each edit names
the lines it replaces, found at the first of three matching tiers (exact, trailing whitespace, leading and
trailing whitespace); every file is changed or nothing is. `SPEC.md` is the whole specification.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is the patch file (or `-`, or absent, for standard input). `--format` picks one of `unified`,
`search-replace`, `v4a`, `json`, or `auto` (the default, which detects it). `--check` does everything but
write. `--strict` matches lines exactly. Node 22, standard library alone; `runner.ts` beside it hands a trial
over to the grader's env when `MAKEFUN_ENV_URL` is set.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
