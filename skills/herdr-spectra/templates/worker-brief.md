# Task <task-id> (<nonce>): <one-line summary>

## What to do
<the task's full text from tasks.md, verbatim>

## Basis
- Implementation Contract: <the excerpt for this task, verbatim>
- Spec: <relevant Requirement / Scenario / Example blocks, verbatim>
- Design: <relevant design.md decisions, verbatim>
- Completed prerequisites: <what the [after] tasks did and in which files>
- TDD rules: <only when tdd: true — the full text of `spectra instructions --skill tdd`>
- Audit lenses: <only when audit: true — Scoundrel (unsafe defaults), Lazy Developer (type confusion), Confused Developer (silent failure), one line each on what to look for>

## Scope
- May modify or create: <file list>
- Must not modify: docs/spectra/**, .herd/briefs/**, files of other tasks

## Verification
<the task's verification commands>
<test tasks only: temporarily break the code under test, confirm the new test fails, restore it, and report the failure summary plus `git diff -- <product path>` after restoring (must be empty)>
Run tools the way AGENTS.md says.

## Rules
- Do not commit, push, edit tasks.md, or run any `spectra` command.
- If the spec or design is unclear or contradictory, stop and report; do not guess.

## Report
Write `.herd/results/<nonce>.json`: JSON only, matching `.claude/skills/herdr-spectra/schemas/worker-report.schema.json` (read it first; every field is required).
- `status`: `done`, or `blocked` with the decision you need in `blocked_question` (otherwise `null`).
- `deviations`: every place the code departs from the literal spec or design text, and why. Empty if none.
- `break_checks`: test tasks only: what you broke, which tests failed, whether the product file was restored. Empty otherwise.
- `scope_sha`: output of `pwsh -NoProfile -File .claude/skills/herdr-spectra/scripts/scope-sha.ps1 <every file under "May modify or create">`, run as your last step.
Check it with `pwsh -NoProfile -File .claude/skills/herdr-spectra/scripts/check-report.ps1 -Path .herd/results/<nonce>.json -Kind worker -Files <same files, comma-separated>` until it prints `"ok":true`.
Then reply with exactly one line: `HERD <nonce> report written`.
