---
name: herdr-spectra
description: Lead a Spectra change through herdr - each task goes to a fresh worker agent (Kiro or Claude Code) in its own pane, the result is committed, a second agent reviews and tests it, and this session triages the review before spectra task done. Use when a Spectra change should be implemented or reviewed by other agents, even without saying herdr - Kiro, Codex, worker/reviewer agents, delegating, parallel agents, 分派、派給 Kiro、多 agent 協作、讓別的模型審查. Prefer it over /spectra-apply then; not for plain herdr pane questions (use the herdr skill).
---

# herdr + Spectra

This session is the **lead**. Per task it spawns a fresh **worker** to implement, commits the result, spawns a fresh **reviewer** to review and test that commit, checks both reports, and closes both agents.

The lead's own usage is the scarce resource: it orchestrates, runs the scripts and triages the reviewer's findings, but never writes the implementation or reviews the diff itself.

- Agents report in JSON (`schemas/`), validated by `check-report.ps1`; each report's `scope_sha` (`scope-sha.ps1`) ties it to the files it saw.
- This skill wraps `/spectra-apply`'s setup and bookkeeping and replaces its implementation step. `tasks.md` checkboxes are task truth; only the lead runs `spectra task start` / `done`.
- Load the `herdr` skill first. Answer in the language AGENTS.md requires.
- Scripts live in `.claude/skills/herdr-spectra/scripts/`; run them from the repo root as `pwsh -NoProfile -File <script> …`. Below, `<s>` stands for that directory.
- Keep tool output small: `git diff --stat` before a full diff, quiet test runners, and only the lines a finding cites plus their callers.

## 0. Preconditions

1. `HERDR_ENV` is `1`; otherwise say the session is not inside herdr and stop.
2. Spectra CLI: `spectra` on PATH, else `$LOCALAPPDATA/Spectra/spectra.exe`; neither → report and stop.
3. Full-permission mode for every agent kind the run uses (1.0). Kiro: `kiro-cli settings list` shows `chat.disableTrustAllConfirmation = true (global)`. Claude Code: `claude` on PATH; the user accepts the bypass-permissions confirmation once if the spawn script reports it. Missing → ask the user; never change an agent's settings yourself.
4. Run `/spectra-apply` steps 1–4 as written (select and announce the change, status/parking, `spectra instructions apply --change "<name>" --json --compact`, `spectra analyze`, drift, read `tdd`/`audit`). Dispatch replaces its step 5.
5. `.herd/` at the repo root, listed in `.git/info/exclude`:
   ```
   .herd/<change>.md            ledger (the scripts append to it)
   .herd/briefs/<nonce>.md      brief
   .herd/results/<nonce>.json   report
   .herd/guard/<nonce>.json     guard state saved at dispatch
   .herd/triage/<task-id>.md    triage (4.4)
   ```
   After compaction or a restart, see `reference.md` § Re-entry.

**Limits are enforced after the fact.** Both roles run with all tools trusted (so the reviewer can run the worker's CLI commands), which also skips any deny rules. `guard-check.ps1` catches violations: changes outside scope, new commits or stashes, edits to `docs/spectra/` (except `tasks.md`) or to the brief.

## 1. Plan

Dispatch every pending task by default. Before starting, show the plan: task → worker (agent, model, effort) → reviewer (agent, model, effort) → reason for any non-default choice → parallel groups (`reference.md` § Parallel tasks). The user's choices override this section.

- Tasks that edit Spectra artifacts: the lead does them per `/spectra-apply` and tells the user.
- Design decision not written down (different agents could implement it inconsistently): stop and have the user run `/spectra-ingest`.
- A task that cannot be dispatched: ask the user before implementing it yourself.

### 1.0 Pick the agents

Once per run, before the plan, ask with `AskUserQuestion`: two questions, worker and reviewer, defaults first and marked "(Recommended)". Skip a question the user already answered.

| Question | Options |
|---|---|
| Worker | Kiro · `claude-sonnet-5.5` (Recommended); Claude Code · `claude-sonnet-5-5`; Kiro · `claude-haiku-5.5`; Claude Code · `claude-haiku-5-5` |
| Reviewer | Kiro · `gpt-5.6-terra` (Recommended); Claude Code · `claude-opus-5-5`; Kiro · `claude-opus-5.5` |

"Other" accepts any agent and model (e.g. Claude Code · `claude-opus-5-5`); verify Kiro models with `kiro-cli chat --list-models` and ask again if one does not exist. Kiro IDs use a dot, Claude Code IDs a dash. Record the picks in the ledger. If the reviewer ends up on the worker's vendor or a weaker model, say so once in the plan and continue.

### 1.1 Effort

The lead sets effort per task from the task text, scope and spec, and writes down the reason.

| Role | Default effort |
|---|---|
| worker | `high` |
| worker, check-only task (runs the suite, updates docs, no product code) | `medium` |
| reviewer | `high` |

- **`claude-haiku-*` never runs below `high`.**
- Any one risk signal raises both roles to `xhigh`: the scope touches deletion, `sudo`, secrets, `.env`, credentials, or path validation guarding a destructive flow; a Basis requirement uses MUST / MUST NOT for a safety property; the scope spans more than one top-level package or changes a contract other modules consume; `audit: true`.
- Keep the reviewer on a different vendor than the worker unless the user picked otherwise. For Kiro, show each model's credit multiplier in the plan.
- Never use Kiro's `auto` model or leave effort unset.

### 1.2 Escalation

- **Round 1** (first rework): same worker, same model and effort.
- **Round 2**: a new worker of the same kind, effort +1 (`low` → `medium` → `high` → `xhigh`); already at `xhigh`, next stronger model of the same vendor (haiku → sonnet → opus). Its brief carries every round's feedback.
- After round 2, ask the user. Log every escalation with its reason.

## 2. Brief

Each dispatch gets a new nonce: `t<task>-<4 hex>` for work, `r<task>-<4 hex>` for review, with the task number's dot as `-` (e.g. `t1-2-a7f3`). Fill `templates/worker-brief.md` into `.herd/briefs/<nonce>.md`; it must be self-contained.

- Copy spec and design text from the files (`grep -n '^###\|^####'`, then `sed -n '<from>,<to>p'`); never retype it. Archived changes are under `docs/spectra/changes/archive/<date>-<name>/`.
- With `tdd: true`, paste the TDD rules themselves; workers cannot run `spectra`.
- Read reports from the file, not the screen; the chat line only signals completion.

## 3. Spawn and dispatch

One fresh agent per task, never an existing pane; rework round 1 reuses the task's worker. At most 4 agents at once.

```
<s>/spawn-agent.ps1 -Name <name> -Role worker|reviewer -Kind kiro|claude -Model <model> -Effort <effort> -Reason "<why>" -Change <change> -TaskId <task-id> [-FromPane <pane>]
```

- Name: `w-<task>-<last 4 of nonce>` or `r-…` (e.g. `w-1-2-a7f3`).
- `-FromPane`: omit for the first agent; afterwards pass the last spawned agent's pane.
- On failure the script exits 1 and leaves the pane open; show the user.

Dispatch a worker:

1. `spectra task start --change "<name>" <task-index>` (the CLI's 1-based index, not the `1.2` label).
2. `<s>/dispatch.ps1 -Name <name> -Nonce <nonce> -TaskId <task-id> -Change <change>` saves the guard state, logs, prompts and waits.

Wait result `idle`/`done` with a report file → section 4. Anything else (no report, `blocked`, `timeout`) → `reference.md` § Wait results. Never answer an agent's dialog for the user, and never resend a prompt before checking the screen and the report file.

## 4. Check, commit, review, triage

### 4.1 Worker report

`<s>/check-report.ps1 -Path .herd/results/<nonce>.json -Kind worker -Files <scope>`. Not ok → send the errors to the same worker, same nonce (not a rework round). `status: blocked` → ask the user `blocked_question`, or, if the design answers it, add the answer to the brief and resend with a new nonce.

### 4.2 Mechanical checks

The diff and the scripts are the evidence, not the worker's account. Any failure goes back to the worker (4.5) without a review.

- `<s>/guard-check.ps1 -Nonce <nonce> -Change <change> -Scope <scope files>`. Not ok → stop the task and show the user the issues; restore nothing. If the lead itself touched Spectra artifacts meanwhile, sort out whose change it is first.
- Every scope file the diff touches is in the report's `files` (`git diff --stat`).
- Run the verification commands yourself and compare with `verification`; for test tasks, repeat each `break_checks` entry (`git checkout -- <file>` restores).
- Run the project's type checker or linter on the touched files, as AGENTS.md specifies.

### 4.2a Commit

Commit the result before any reviewer sees it, so the reviewer cannot silently change the code under review.

```
<s>/commit-task.ps1 -Files <scope files> -TaskId <task-id> -Round <n> -Change <change>
```

It commits only those files, logs the commit (so `guard-check.ps1` accepts it) and prints `{commit, parent}`. Round 1's `parent` is the task's **base**. Never push. These per-round commits are rollback points; 4.7 squashes them once their group is done.

### 4.3 Review

1. Fill `templates/reviewer-brief.md` (Basis and Scope from the worker brief, the worker's `deviations` verbatim, `<base>` and `<commit>` from 4.2a).
2. Spawn the reviewer (1.0, 1.1) and run `dispatch.ps1` with its `r…` nonce (no `task start`).
3. When it reports, `<s>/guard-check.ps1 -Nonce <r-nonce> -Change <change>`. Not ok → stop and show the user `git status` and `git diff`; the commit still holds the worker's version.
4. `<s>/check-report.ps1 -Path … -Kind review -Files <scope> [-PriorIds …]`. Not ok → send the errors once; a second failure means the review failed: log `review failed`, then spawn a new reviewer or ask the user. A failed review never passes.

### 4.4 Triage

Check the reviewer's report item by item and record every decision in `.herd/triage/<task-id>.md`; a decision not in the file does not exist.

1. After the whole report arrives, copy every finding as an `R` row, source `reviewer`.
2. Check each claim on its own: can the behavior happen at that location? Read callers and upstream guards for a definite answer.
3. Grade each by what one occurrence does, ignoring the reviewer's `confidence`, with one sentence of evidence:
   - `high`: data loss or corruption, security exposure, silently wrong result, broken path with no workaround, violated MUST.
   - `medium`: wrong but noticeable or workable, limited reach, or a spec scenario not done. Unsure between medium and low → `medium`.
   - `low`: cosmetic or minor. `violates: none` is `low` unless the consequence is high or medium.
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

- `spectra task done --change "<name>" <task-index> --file <path> …`, listing every file the diff confirms. Always pass `--file`: the baseline covers the whole tree, so other changes would be misattributed.
- Ledger: `<time> <task-id> done` plus triage summary (`F` by verdict, rejected `R` count, open `low` ids). Then close agents (5) and clean up (6).

### 4.7 Squash a finished group

When every task of a `tasks.md` group (`## 3. …` → tasks `3.x`) is done and no task is in flight (no agent working, no review open), replace the group's per-round commits with one:

```
<s>/squash-group.ps1 -Group <n> -Change <change> -Message "herd(<change>): <n>. <group heading>"
```

It refuses when other commits are mixed into the group's range (parallel groups, user commits): leave those commits and list them in the final report. Tasks in flight at that moment → squash after they settle, before the next dispatch. The ledger keeps the old HEAD (`was <sha>`) for recovery.

## 5. Close agents

`<s>/close-agent.ps1 -Name <name> -Change <change>` once the task passes. It refuses panes without a `spawn` ledger line and agents that are not `idle`/`done`; never close panes with a bare `herdr pane close`. Leave agents of tasks handed to the user open.

## 6. Clean up `.herd/`

- Task passes: delete its briefs, reports, guard files and triage file; the ledger line is the record.
- Run ends: run `/spectra-apply` step 6, delete the ledger, and remove `.herd/` if empty.
- Keep files of blocked or handed-over tasks and say so in the final report.
- Delete only files this skill created.

## 7. Final report

- Table: task → worker (agent, model, effort) → reviewer (agent, model, effort) → escalations → triage (`F` by verdict, rejected `R`) → rounds → result.
- Rejected findings with their reasons, so the user can overrule them.
- Open `low` findings.
- Progress from `spectra instructions apply --change "<name>" --json --summary`; when all done, recommend `/spectra-verify` and `/spectra-review` before `/spectra-archive`.
- The run's commits (`git log --oneline <first base>..HEAD`; one per group after 4.7, plus any it refused), not pushed; the user keeps, squashes or redoes them via `/spectra-commit`.
- What was cleaned up and what was left behind.

## Never

- Implement a code task, or answer an agent's dialog, for the user without asking.
- Push, or commit or rewrite history except through `commit-task.ps1` and `squash-group.ps1`.
- Hand a result to a reviewer before it is committed, or pass a task whose `guard-check.ps1` failed.
- Act on a report that fails `check-report.ps1`, or pass a task on the reviewer's word alone.
- Keep dispatching after requirements change; have the user run `/spectra-ingest` first.
- Create workspaces, tabs or worktrees without consent (agent panes from section 3 are fine).
