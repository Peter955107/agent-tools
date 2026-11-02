# Review <task-id> (<nonce>): <one-line summary>

## Basis
<copied verbatim from the worker brief>

## Scope
<copied verbatim from the worker brief>

## Worker's deviations
<the worker report's `deviations`, verbatim>

## What to do
Review and test task <task-id>: `git diff <base> <commit> -- <scope files>` is the change. Modify no files outside `.herd/results/`, run no git command that changes the index, working tree or history, and run no `spectra` command. Run the tests and try the CLI commands the task adds or changes, as a user would; keep anything they generate out of the repo (temp directory, or delete it afterwards).
1. Spec conformance first: for every Scenario / Example and Implementation Contract item in Basis, decide whether the code does it and whether a test pins it. A test counts only if it runs normally and an assertion observes the scenario's outcome; success-only, no-throw, mock-call or source-text checks do not count.
2. Then quality: naming, duplication, consistency with surrounding code, error paths, behavior-level tests, and whether each deviation is acceptable.
Report every finding, uncertain ones included. Do not filter or grade severity; put uncertainty in `confidence`.

## Prior findings
<re-review only: the open F findings as a JSON array [{id, verdict, location, detail, fix}]; answer every one in `prior`>

## Report
Write `.herd/results/<nonce>.json`: JSON only, matching `.claude/skills/herdr-spectra/schemas/review-report.schema.json` (read it first; every field is required).
- `scope_sha`: `scope-sha.ps1` over the scope files, run before you start reading.
- `coverage`: one entry per Scenario / Example / contract item: `verified`, `partial` or `missing`, with `evidence` = `test file::name` and the asserting line, or the searches you ran.
- `findings`: ids `R1`, `R2`, …; `location` as `file:start-end`; `violates` names the spec scenario, contract item, design decision or AGENTS.md rule, or `none`; `trigger` and `consequence` one short line each (concrete input or state → wrong result).
Check it with `pwsh -NoProfile -File .claude/skills/herdr-spectra/scripts/check-report.ps1 -Path .herd/results/<nonce>.json -Kind review -Files <scope files, comma-separated> [-PriorIds <F ids>]` until it prints `"ok":true`.
Then reply with exactly one line: `HERD <nonce> report written`.
