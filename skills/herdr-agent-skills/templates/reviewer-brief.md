# Review <task-id> (<nonce>): <one-line summary>

## Basis
<copied verbatim from the worker brief: What to do, Basis>

## Scope
<copied verbatim from the worker brief>

## Worker's deviations
<the worker report's `deviations`, verbatim>

## How to review
Read `<path of code-review-and-quality SKILL.md>` and follow its Review Process (tests first, then the five axes). Ignore its severity labels and approval step: report every finding ungraded, as described below.

## What to do
Review and test task <task-id>: `git diff <base> <commit> -- <scope files>` is the change. Modify no files outside `.herd/results/`, run no git command that changes the index, working tree or history, and do not edit the spec, plan or todo files. Run the task's verification commands and try what the task adds or changes, as a user would; keep anything they generate out of the repo (temp directory, or delete it afterwards).
1. Acceptance first: for every acceptance criterion in Basis, and every spec success criterion it traces to, decide whether the code does it and whether a test pins it. A test counts only if it runs normally and an assertion observes the outcome; success-only, no-throw, mock-call or source-text checks do not count.
2. Then the five axes: correctness (edge cases, error paths), readability and simplicity, architecture (fits the plan's decisions and the surrounding patterns), security (untrusted input, secrets), performance. Also: scope creep beyond the task, a lowered bar (skipped tests, weakened assertions, new suppressions), and whether each deviation is acceptable.
Report every finding, uncertain ones included. Do not filter or grade severity; put uncertainty in `confidence`.

## Prior findings
<re-review only: the open F findings as a JSON array [{id, verdict, location, detail, fix}]; answer every one in `prior`>

## Report
Write `.herd/results/<nonce>.json`: JSON only, matching `.claude/skills/herdr-agent-skills/schemas/review-report.schema.json` (read it first; every field is required).
- `scope_sha`: `scope-sha.ps1` over the scope files, run before you start reading.
- `coverage`: one entry per acceptance criterion (and traced spec success criterion): `verified`, `partial` or `missing`, with `evidence` = `test file::name` and the asserting line, or the searches you ran.
- `findings`: ids `R1`, `R2`, …; `location` as `file:start-end`; `violates` names the acceptance criterion, spec success criterion, plan decision, boundary or CLAUDE.md / AGENTS.md rule, or `none`; `trigger` and `consequence` one short line each (concrete input or state → wrong result).
- `aspects_checked`: the axes and checks you actually covered (e.g. `acceptance`, `correctness`, `readability`, `architecture`, `security`, `performance`, `scope`, `bar`).
Check it with `pwsh -NoProfile -File .claude/skills/herdr-agent-skills/scripts/check-report.ps1 -Path .herd/results/<nonce>.json -Kind review -Files <scope files, comma-separated> [-PriorIds <F ids>]` until it prints `"ok":true`.
Then reply with exactly one line: `HERD <nonce> report written`.
