[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kizu-gatekeeper/mend-cli-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kizu-gatekeeper/mend-cli-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format.

AI harnesses apply edits that models write, and models write edits in four
different formats. `mend` reads all four of them to one specification and
applies them to a tree of text files:

- **unified diffs** — including hunks whose line numbers are wrong; the hunk
  is placed at the occurrence nearest its stated position;
- **SEARCH/REPLACE blocks** — the `<<<<<<< SEARCH` / `=======` /
  `>>>>>>> REPLACE` form, with the file named on a nearby line;
- **V4A patches** — `*** Begin Patch` … `*** End Patch` with Add, Delete and
  Update sections, anchored and end-of-file chunks, and file moves;
- **JSON edits** — text-editor tool calls (`create`, `str_replace`,
  `insert`) as a JSON array or as JSON Lines.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a patch file relative to the working directory; omit it (or pass
`-`) to read the patch from standard input. The working directory is the root
of the tree every patch path is relative to.

- `--format=NAME` forces one format: `unified`, `search-replace`, `v4a` or
  `json`. The default, `auto`, detects the format from the patch text.
- `--check` reports exactly what would happen — same output, same exit
  code — but writes nothing.
- `--strict` matches lines exactly. Without it, an edit's old lines are
  searched for at three tiers: exact, then ignoring trailing whitespace,
  then ignoring leading whitespace too, so an edit still lands when the
  model drifted the whitespace or indentation of the lines it names. At the
  loosest tier the replacement is re-indented to match the file.

## Guarantees

- **Atomic.** Every file changes, or none does. A failed edit changes
  nothing itself, the remaining edits still run so every failure is
  reported, and if any edit failed no file is written at all.
- **Exact reporting.** Exit 0 prints one line per changed path (`A`, `D`,
  `M`, or `R old -> new` for a move) plus an `ok:` summary. Exit 1 prints
  one `error: <code> <path>` line per failed edit plus a `failed:` summary.
  Exit 2 prints a single usage / no-patch / format / parse error line.
- **Safe paths only.** Absolute paths, backslashes, and empty, `.` or `..`
  segments are rejected as `unsafe` before anything else about the edit is
  considered.
- **File shape preserved.** A changed file keeps its own line breaks (LF or
  CRLF) and keeps or drops its final line break exactly as the format rules
  dictate; created files are written with LF breaks.

`mend` is a single `main.ts` using nothing beyond the Node 22 standard
library — nothing to install. `runner.ts` beside it is the make.fun kit
runner used when the tool runs inside a trial.

## License

MIT — see `LICENSE`.
