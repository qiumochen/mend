# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/qiumochen/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/qiumochen/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. mend applies a unified diff (wrong line numbers and all), SEARCH/REPLACE
blocks, a V4A patch or JSON text-editor edits to the tree of files under the working directory. It finds the lines an
edit names at the first of three tiers (exact, trailing whitespace ignored, surrounding whitespace ignored, re-indenting
the new lines to the file's own indent), and writes every change or none.

## Run it

```sh
node main.ts [--format=auto|unified|search-replace|v4a|json] [--check] [--strict] [PATCH]
```

PATCH absent or `-` reads standard input. Node 22 and its standard library only: nothing to install.

- `main.ts`: the CLI.
- `tests/edge.ts`: edge cases from the specification (`node tests/edge.ts`).
- `runner.ts`, `check.ts`: the make.fun kit's trial runner and practice checker
  (`node check.ts <kit>/program/generator/practice.json`), MIT, Copyright (c) 2026 the make.fun team.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
