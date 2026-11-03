# Task <task-id> (<nonce>): <one-line summary>

## What to do
<the task's full entry from the todo file, verbatim: title, description, acceptance criteria, verification, files, dependencies>

## Basis
- Plan: <the plan decisions and risks this task relies on, verbatim from the plan file>
- Spec: <the spec sections this task implements — objective, format, boundaries, success criteria it traces to — verbatim>
- Completed prerequisites: <what the tasks it depends on did and in which files>

## How to work
Read these skill files before writing code and follow them (they are instructions, not background):
- `<path of incremental-implementation SKILL.md>` — one slice at a time, keep it compilable, Rule 0.5 scope discipline.
- `<path of test-driven-development SKILL.md>` — write the failing test first (RED), then make it pass (GREEN), then refactor; for a bug fix, the Prove-It pattern.
- `<path of debugging-and-error-recovery SKILL.md>` — when a test or build fails and the cause is not obvious.
<only when the task needs it, e.g. security-and-hardening, frontend-ui-engineering, api-and-interface-design: one more line each>

## Scope
- May modify or create: <file list>
- Must not modify: <spec / plan / todo files>, .herd/**, files of other tasks

## Verification
<the task's verification commands, verbatim>
<test tasks only: temporarily break the code under test, confirm the new test fails, restore it, and report the failure summary plus `git diff -- <product path>` after restoring (must be empty)>
Run tools the way CLAUDE.md / AGENTS.md says.

## Rules
- Do not commit, push, stage, or edit the spec, plan or todo files; do not tick checkboxes.
- If the spec or plan is unclear or contradictory, or the task needs a file outside Scope, stop and report `blocked`; do not guess and do not widen the scope.
- Do not lower the bar to get green: no skipped or deleted tests, no weakened assertions, no new suppressions (`@ts-ignore`, `eslint-disable`, `# type: ignore`).

## Report
Write `.herd/results/<nonce>.json`: JSON only, matching `.claude/skills/herdr-agent-skills/schemas/worker-report.schema.json` (read it first; every field is required).
- `status`: `done`, or `blocked` with the decision you need in `blocked_question` (otherwise `null`).
- `tests`: every test you added or changed, with the acceptance criterion it pins in `covers`.
- `deviations`: every place the code departs from the literal task, spec or plan text, and why. Empty if none.
- `break_checks`: test tasks only: what you broke, which tests failed, whether the product file was restored. Empty otherwise.
- `scope_sha`: output of `pwsh -NoProfile -File .claude/skills/herdr-agent-skills/scripts/scope-sha.ps1 <every file under "May modify or create">`, run as your last step.
Check it with `pwsh -NoProfile -File .claude/skills/herdr-agent-skills/scripts/check-report.ps1 -Path .herd/results/<nonce>.json -Kind worker -Files <same files, comma-separated>` until it prints `"ok":true`.
Then reply with exactly one line: `HERD <nonce> report written`.
