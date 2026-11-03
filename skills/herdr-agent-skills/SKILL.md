---
name: herdr-agent-skills
description: Execute an agent-skills plan (tasks/spec.md + tasks/plan.md + tasks/todo.md from spec-driven-development and planning-and-task-breakdown) through herdr - each task goes to a fresh worker agent (Kiro or Claude Code) in its own pane that follows incremental-implementation and test-driven-development, the result is committed, a second agent reviews it with code-review-and-quality, this session triages the review, ticks todo.md and stops at every checkpoint for human review. Use when an approved todo.md should be implemented by other agents, even without saying herdr - Kiro, worker/reviewer agents, delegating, parallel agents, 分派任務、派給 Kiro、多 agent 協作、讓別的模型實作或審查 todo. Not for Spectra changes (use herdr-spectra) or plain herdr pane questions (use the herdr skill).
---

# herdr + agent-skills

This session is the **lead**. Per task in `tasks/todo.md` it spawns a fresh **worker** to implement, commits the result, spawns a fresh **reviewer** to review and test that commit, checks both reports, ticks the task, and closes both agents. At every checkpoint in the todo file it stops for the human.

The lead's own usage is the scarce resource: it orchestrates, runs the scripts and triages the reviewer's findings, but never writes the implementation or reviews the diff itself.

- Agents report in JSON (`schemas/`), validated by `check-report.ps1`; each report's `scope_sha` (`scope-sha.ps1`) ties it to the files it saw.
- This skill is the Implement phase of `spec-driven-development` (its Phase 4) with the agent-skills workflow split across agents: workers follow `incremental-implementation` and `test-driven-development`, reviewers follow `code-review-and-quality`. The todo file's checkboxes are task truth; only the lead ticks them.
- Load the `herdr` skill first. Answer in the language CLAUDE.md / AGENTS.md requires.
- Scripts live in `.claude/skills/herdr-agent-skills/scripts/`; run them from the repo root as `pwsh -NoProfile -File <script> …`. Below, `<s>` stands for that directory.
- Keep tool output small: `git diff --stat` before a full diff, quiet test runners, and only the lines a finding cites plus their callers.

## 0. Preconditions

1. `HERDR_ENV` is `1`; otherwise say the session is not inside herdr and stop.
2. **Plan files.** Find the spec (`tasks/spec.md`, `SPEC.md`, or the module spec named in a capability map), `tasks/plan.md` and the task list target. The task list must be a markdown todo file (default `tasks/todo.md`); if `plan.md` says tasks live in an external tracker, report that this skill does not support it and stop.
3. **Approval gate.** agent-skills requires the human to approve the spec and the plan before implementation. If the conversation or the files do not show that approval, ask once; no approval → stop.
4. **Skill files.** Resolve the `SKILL.md` path of `incremental-implementation`, `test-driven-development`, `debugging-and-error-recovery` and `code-review-and-quality` by the `name:` in their frontmatter (search `.claude/skills/*/SKILL.md`, then `.kiro/skills/*/SKILL.md`; folder names can differ, e.g. `test-driven-development-2`). Briefs point agents at these paths. Any missing → report and stop.
5. Full-permission mode for every agent kind the run uses (1.0). Kiro: `kiro-cli settings list` shows `chat.disableTrustAllConfirmation = true (global)`. Claude Code: `claude` on PATH; the user accepts the bypass-permissions confirmation once if the spawn script reports it. Missing → ask the user; never change an agent's settings yourself.
6. **Change name** `<change>`: kebab-case of the plan's title (e.g. `bundle-format-v2`); used in ledger, commits and script arguments.
7. **Protected paths**: the spec, the plan and any other files under `tasks/` except the todo file. Pass them as `-Protected` and the todo file as `-Todo` to `dispatch.ps1`.
8. `.herd/` at the repo root, listed in `.git/info/exclude`:
   ```
   .herd/<change>.md            ledger (the scripts append to it)
   .herd/briefs/<nonce>.md      brief
   .herd/results/<nonce>.json   report
   .herd/guard/<nonce>.json     guard state saved at dispatch
   .herd/triage/<task-id>.md    triage (4.4)
   ```
   After compaction or a restart, see `reference.md` § Re-entry.

**Limits are enforced after the fact.** Both roles run with all tools trusted (so the reviewer can run the worker's commands), which also skips any deny rules. `guard-check.ps1` catches violations: changes outside scope, new commits or stashes, edits to the protected spec/plan files, to the todo file or to the brief.

## 1. Plan the run

Read the todo file. The run covers the unchecked tasks **up to the next unchecked checkpoint**; tasks after it wait until the human passes that checkpoint (4.7). Before starting, show: task → worker (agent, model, effort) → reviewer (agent, model, effort) → reason for any non-default choice → parallel groups (`reference.md` § Parallel tasks) → the checkpoint the run stops at. The user's choices override this section.

- A task sized **L or XL**, with more than ~5 files, or without acceptance criteria or a verification step, breaks `planning-and-task-breakdown`'s sizing rules: ask the user to split or complete it before dispatching.
- A task that needs a design decision the spec and plan do not record (different agents could implement it inconsistently): stop. The spec is a living document; the user updates it first (`spec-driven-development` § Keeping the Spec Alive), then the run continues.
- A task that only edits the spec or plan: the lead does it with the user, not an agent.
- A task that cannot be dispatched (needs credentials, a device, a GUI the agents cannot drive): ask the user before implementing it yourself.

### 1.0 Pick the agents

Once per run, before the plan, ask with `AskUserQuestion`: two questions, worker and reviewer, defaults first and marked "(Recommended)". Skip a question the user already answered.

| Question | Options |
|---|---|
| Worker | Kiro · `claude-sonnet-5.5` (Recommended); Claude Code · `claude-sonnet-5-5`; Kiro · `claude-haiku-5.5`; Claude Code · `claude-haiku-5-5` |
| Reviewer | Kiro · `gpt-5.6-terra` (Recommended); Claude Code · `claude-opus-5-5`; Kiro · `claude-opus-5.5` |

"Other" accepts any agent and model (e.g. Claude Code · `claude-opus-5-5`); verify Kiro models with `kiro-cli chat --list-models` and ask again if one does not exist. Kiro IDs use a dot, Claude Code IDs a dash. Record the picks in the ledger. If the reviewer ends up on the worker's vendor or a weaker model, say so once in the plan and continue — `code-review-and-quality` § Multi-Model Review Pattern is the reason for a different vendor.

### 1.1 Effort

The lead sets effort per task from the task text, its size and the spec, and writes down the reason.

| Role | Default effort |
|---|---|
| worker, size S/M | `high` |
| worker, size XS or check-only task (runs the suite, updates docs, no product code) | `medium` |
| reviewer | `high` |

- **`claude-haiku-*` never runs below `high`.**
- Any one risk signal raises both roles to `xhigh`: the scope touches deletion, secrets, credentials, untrusted input parsing, or path validation guarding a destructive flow; the task implements something the spec's Boundaries list under **Never** or **Ask first**; the scope changes a contract other modules consume (a shared type, an IPC or API shape, a file format); the plan's Risks table rates the task's risk `High`.
- Keep the reviewer on a different vendor than the worker unless the user picked otherwise. For Kiro, show each model's credit multiplier in the plan.
- Never use Kiro's `auto` model or leave effort unset.

### 1.2 Escalation

- **Round 1** (first rework): same worker, same model and effort.
- **Round 2**: a new worker of the same kind, effort +1 (`low` → `medium` → `high` → `xhigh`); already at `xhigh`, next stronger model of the same vendor (haiku → sonnet → opus). Its brief carries every round's feedback.
- After round 2, ask the user. Log every escalation with its reason.

## 2. Brief

Each dispatch gets a new nonce: `t<n>-<4 hex>` for work, `r<n>-<4 hex>` for review, where `<n>` is the task's number (`T3` → `3`, `Task 3.1` → `3-1`; e.g. `t3-a7f3`). Fill `templates/worker-brief.md` into `.herd/briefs/<nonce>.md`; it must be self-contained.

- **What to do**: the task's whole entry from the todo file, verbatim.
- **Basis**: the plan decisions, risks and spec sections the task relies on, verbatim. Find them with `grep -n '^##\|^###\|^####'`, then `sed -n '<from>,<to>p'`; never retype or summarize them. Include the spec's Boundaries and the success criteria the task traces to.
- **How to work**: the resolved skill paths from 0.4; add a domain skill (`security-and-hardening`, `frontend-ui-engineering`, `api-and-interface-design`, …) only when the task needs it.
- **Scope**: the task's "Files" list. A path written as "tests" or "(only the type usages)" becomes explicit file paths or a stated limit.
- Read reports from the file, not the screen; the chat line only signals completion.

## 3. Spawn and dispatch

One fresh agent per task, never an existing pane; rework round 1 reuses the task's worker. At most 4 agents at once.

```
<s>/spawn-agent.ps1 -Name <name> -Role worker|reviewer -Kind kiro|claude -Model <model> -Effort <effort> -Reason "<why>" -Change <change> -TaskId <task-id> [-FromPane <pane>]
```

- Name: `w-<n>-<last 4 of nonce>` or `r-…` (e.g. `w-3-a7f3`).
- `-FromPane`: omit for the first agent; afterwards pass the last spawned agent's pane.
- On failure the script exits 1 and leaves the pane open; show the user.

Dispatch a worker:

```
<s>/dispatch.ps1 -Name <name> -Nonce <nonce> -TaskId <task-id> -Change <change> -Protected <spec,plan,…> -Todo <todo file>
```

It saves the guard state, logs, prompts and waits. Wait result `idle`/`done` with a report file → section 4. Anything else (no report, `blocked`, `timeout`) → `reference.md` § Wait results. Never answer an agent's dialog for the user, and never resend a prompt before checking the screen and the report file.

## 4. Check, commit, review, triage

### 4.1 Worker report

`<s>/check-report.ps1 -Path .herd/results/<nonce>.json -Kind worker -Files <scope>`. Not ok → send the errors to the same worker, same nonce (not a rework round). `status: blocked` → ask the user `blocked_question`, or, if the spec or plan answers it, add the answer to the brief and resend with a new nonce. A question the spec should have answered is also a spec update for the user (1, second bullet).

### 4.2 Mechanical checks

The diff and the scripts are the evidence, not the worker's account. Any failure goes back to the worker (4.5) without a review.

- `<s>/guard-check.ps1 -Nonce <nonce> -Change <change> -Scope <scope files>`. Not ok → stop the task and show the user the issues; restore nothing. If the lead itself touched the protected files meanwhile, sort out whose change it is first.
- Every scope file the diff touches is in the report's `files` (`git diff --stat`).
- Run the task's verification commands yourself and compare with `verification`; for test tasks, repeat each `break_checks` entry (`git checkout -- <file>` restores).
- Run the project's type checker or linter on the touched files, as CLAUDE.md / AGENTS.md specifies.
- The bar was not lowered: `git diff` adds no skipped tests, no deleted tests, no new suppressions.

### 4.2a Commit

Commit the result before any reviewer sees it, so the reviewer cannot silently change the code under review.

```
<s>/commit-task.ps1 -Files <scope files> -TaskId <task-id> -Round <n> -Change <change>
```

It commits only those files, logs the commit (so `guard-check.ps1` accepts it) and prints `{commit, parent}`. Round 1's `parent` is the task's **base**. Never push.

### 4.3 Review

1. Fill `templates/reviewer-brief.md` (Basis and Scope from the worker brief, the worker's `deviations` verbatim, the `code-review-and-quality` path, `<base>` and `<commit>` from 4.2a).
2. Spawn the reviewer (1.0, 1.1) and run `dispatch.ps1` with its `r…` nonce and the same `-Protected` / `-Todo`.
3. When it reports, `<s>/guard-check.ps1 -Nonce <r-nonce> -Change <change>`. Not ok → stop and show the user `git status` and `git diff`; the commit still holds the worker's version.
4. `<s>/check-report.ps1 -Path … -Kind review -Files <scope> [-PriorIds …]`. Not ok → send the errors once; a second failure means the review failed: log `review failed`, then spawn a new reviewer or ask the user. A failed review never passes.

### 4.4 Triage

Check the reviewer's report item by item and record every decision in `.herd/triage/<task-id>.md`; a decision not in the file does not exist.

1. After the whole report arrives, copy every finding as an `R` row, source `reviewer`.
2. Check each claim on its own: can the behavior happen at that location? Read callers and upstream guards for a definite answer.
3. Grade each by what one occurrence does, ignoring the reviewer's `confidence`, with one sentence of evidence:
   - `high`: data loss or corruption, security exposure, silently wrong result, broken path with no workaround, an unmet acceptance criterion, a violated **Never** boundary.
   - `medium`: wrong but noticeable or workable, limited reach, a traced spec success criterion not met, or a lowered bar. Unsure between medium and low → `medium`.
   - `low`: cosmetic or minor (`code-review-and-quality`'s Nit / Optional). `violates: none` is `low` unless the consequence is high or medium.
   - `false`: not real, with what disproves it. `maybe-false`: settle it by reading or running more; still open → ask the user before passing.
4. Check each coverage entry: the cited test runs normally and its assertion observes the outcome. A failed `verified`, and every `partial` or `missing`, becomes an `R` with source `coverage`, graded `medium`.
5. Re-review: confirm each `resolved` prior finding; unconfirmed or `open` stays open.
6. Defects found while checking become `R` rows with source `lead`; do not look for more.
7. Group by root cause into `F` findings (numbering continues across rounds; a new `R` with an existing root cause joins that `F`). An `F` takes its members' highest verdict, locations, ids and the fix. Rejected `R` rows stay, marked with the reason.

```markdown
## Round <n>: review <nonce> (<model>), scope_sha <sha>
| R | source | location | claim | verdict | evidence |
| F | verdict | members | locations | detail | fix | status |
```

**Pass**: no open `high`/`medium` `F`, no unresolved `maybe-false`, and the review passed 4.3. Open `low` findings are fixed in a rework round if one happens, otherwise listed in the final report.

### 4.5 Rework

Write a new brief under a new nonce: the original brief plus `## Round <n> feedback` with the open `F` findings as `[{id, verdict, location, detail, fix}]`. Dispatch it to the worker 1.2 names (round 2: close the old worker first). After 4.1–4.2a, the same reviewer re-reviews `git diff <base> <new commit>` with the findings under Prior findings (`-PriorIds` on the check). At most 2 rounds, then ask the user.

### 4.6 Pass

- **Tick the todo file** only while no agent of the run is working (guard-check flags todo edits made during a dispatch): the task's acceptance-criteria checkboxes and its title line. A criterion the lead could not confirm (e.g. a manual check) stays unchecked and goes to the checkpoint (4.7). If `plan.md` mirrors the task list, tick it at the same moment.
- An accepted `deviation` that changes what the spec or plan says: list it for the user; the spec is updated by the user, not silently by the lead.
- Ledger: `<time> <task-id> done` plus triage summary (`F` by verdict, rejected `R` count, open `low` ids). Then close agents (5) and clean up (6).

### 4.7 Checkpoint

When every task before an unchecked checkpoint has passed:

1. Run the checkpoint's own commands yourself (full test suite, type check, build) and tick what you verified.
2. List for the user what only a human can confirm: manual or E2E checks, unchecked acceptance criteria from 4.6, accepted deviations, open `low` findings.
3. **Stop and ask the user to review**, as `planning-and-task-breakdown` requires ("Review with human before proceeding"). Tick the checkpoint's review item and start the next run (1) only after the user says so.

## 5. Close agents

`<s>/close-agent.ps1 -Name <name> -Change <change>` once the task passes. It refuses panes without a `spawn` ledger line and agents that are not `idle`/`done`; never close panes with a bare `herdr pane close`. Leave agents of tasks handed to the user open.

## 6. Clean up `.herd/`

- Task passes: delete its briefs, reports, guard files and triage file; the ledger line is the record.
- Run ends at a checkpoint or the last task: keep the ledger until the whole todo file is done, then delete it and remove `.herd/` if empty.
- Keep files of blocked or handed-over tasks and say so in the final report.
- Delete only files this skill created.

## 7. Final report (per run)

- Table: task → worker (agent, model, effort) → reviewer (agent, model, effort) → escalations → triage (`F` by verdict, rejected `R`) → rounds → result.
- Rejected findings with their reasons, so the user can overrule them.
- Open `low` findings, accepted deviations and spec updates the user should make.
- Progress: ticked / total tasks in the todo file, and the checkpoint the run stopped at with its open items (4.7).
- The run's commits (`git log --oneline <first base>..HEAD`), not pushed; the user keeps, squashes or rewrites them (`git-workflow-and-versioning`, or the project's commit skill). The todo ticks are uncommitted.
- When the whole todo file is done: recommend a whole-branch review (`code-review-and-quality` over `git diff <first base>..HEAD`, or `/code-review`) and `shipping-and-launch` before merging.
- What was cleaned up and what was left behind.

## Never

- Implement a code task, or answer an agent's dialog, for the user without asking.
- Push, or commit anything except through `commit-task.ps1`.
- Hand a result to a reviewer before it is committed, or pass a task whose `guard-check.ps1` failed.
- Act on a report that fails `check-report.ps1`, or pass a task on the reviewer's word alone.
- Continue past an unchecked checkpoint without the user's go.
- Edit the spec or plan to match the code, or keep dispatching after requirements change; the user updates the spec first.
- Create workspaces, tabs or worktrees without consent (agent panes from section 3 are fine).
