---
name: herdr-spectra
description: Lead a Spectra change through herdr so the coding work runs on other AI subscriptions instead of this session. Every task goes to a fresh Kiro agent (explicit model) in a new herdr pane; each result gets a read-only review by a different-vendor model in Kiro, and this session (Claude) checks every finding and coverage claim of that review against the code; tasks are recorded with spectra task start/done and the agents are closed afterwards. Use this whenever a Spectra change is to be implemented or reviewed and the user wants other agents involved, even without saying "herdr" - e.g. Kiro, Codex, worker or reviewer agents, delegating tasks, multi-agent or parallel agents, "let another model review it", or Chinese like 分派、派給 Kiro、開 agent 來做、多 agent 協作、讓別的模型審查. Prefer it over /spectra-apply in those cases. Not for applying a change alone, and not for plain herdr pane/layout questions with no Spectra change (use the herdr skill).
---

# herdr + Spectra

This session is the **lead**. For each task the lead spawns a fresh **worker** that implements it and a fresh **reviewer** that reviews it read-only, checks both reports, and closes both. Default agent: **Kiro** in auto mode with an explicit model. Use another kind only when the user names one.

**Why this skill exists**: to spread usage across the user's AI subscriptions and to have every task reviewed by a model from another vendor. The lead's own usage is the scarce resource, so the lead orchestrates, runs the mechanical checks, and **checks the reviewer's results item by item**, but neither writes the implementation nor reviews the diff itself. Finding problems is the reviewer's job; deciding whether each one is real and how much it matters is the lead's (BMAD triage: a reviewer "lacks the context to grade").

**Agents talk through JSON files, not prose.** Worker and reviewer reports follow `schemas/worker-report.schema.json` and `schemas/review-report.schema.json`, and `scripts/check-report.ps1` rejects anything else before the lead reads it. Every report carries a `scope_sha` (`scripts/scope-sha.ps1` over the task's scope files), so a report is never applied to files that changed after it was written.

This skill wraps `/spectra-apply`'s setup and bookkeeping and replaces its implementation step. Spectra rules still hold: `tasks.md` checkboxes are task truth, and only the lead attributes tasks (`spectra task start` / `spectra task done`). Workers never run them.

For generic herdr rules (IDs come from JSON, `--no-focus`, never close what you did not create, never `herdr server stop`, `--trust-repository` only after the user verifies the repo), follow the `herdr` skill. Load it first.

Respond to the user in the language AGENTS.md requires.

Sources of the design: BMAD (self-contained story, reviewer on a different LLM, launch prompts carry paths rather than content, reviewers report without severity and the lead triages them into `R`/`F` findings), Superpowers (spec review before quality review), oh-my-claudecode verifier (per-criterion `verified`/`partial`/`missing` with evidence), agent-orchestrator and Gas Town (a review is bound to the exact tree it saw), BMAD party mode `subagent` (independent agents instead of one mind voicing every side), Claude Squad (one isolated agent per task).

## 0. Preconditions

1. `HERDR_ENV` must be `1`; otherwise say the session is not inside herdr and stop.
2. **Spectra CLI**: use `spectra` if it is on PATH, else `$LOCALAPPDATA/Spectra/spectra.exe`. If neither works, report it and stop.
3. **Kiro auto mode**: `kiro-cli settings list` must show `chat.disableTrustAllConfirmation = true (global)`. If it is missing, stop and ask the user; never change Kiro settings yourself. The setting cannot be set per workspace.
4. **Run `/spectra-apply` steps 1–4 as written**: select the change and announce "Using change: <name>", check status/parking, `spectra instructions apply --change "<name>" --json --compact`, `spectra analyze`, drift when dormancy is triggered, and read `.spectra.yaml` (`tdd`, `audit`). Dispatch starts only where `/spectra-apply` step 5 would start implementing.
5. **Scratch directory `.herd/`** at the repo root, excluded through `.git/info/exclude` (local only, so `.gitignore` stays untouched). Add the `.herd/` line if it is missing. Layout:
   ```
   .herd/<change>.md            ledger: one line per spawn, dispatch, report, review, triage, close, cleanup
   .herd/briefs/<nonce>.md      brief for a worker or reviewer
   .herd/results/<nonce>.json   report written by the worker or reviewer (JSON, see the schemas)
   .herd/triage/<task-id>.md    the lead's triage of every review round of one task (4.4)
   ```
   On re-entry (for example after context compaction), read the ledger first and never re-dispatch a task that is in flight or done. Section 6 defines when these files are deleted.

## 1. Plan the dispatch

**Every pending task is dispatched by default.** Before starting, show the user a plan: each task → worker model → reviewer model, and which tasks run in parallel.

- **Order**: follow task order; tasks whose `[after: …]` prerequisites are all done and whose files and tests are disjoint may run in parallel (3.2). This is the grouping `/spectra-apply` step 4 defines.
- **Default models**: worker `claude-sonnet-5.5`; reviewer `gpt-5.6-terra`, so the review comes from a different vendor than the implementation. The user's choices win. If the user changes the worker to a non-Claude model, pick the reviewer from another vendor still.

Exceptions:
- Tasks that edit Spectra artifacts (proposal, design, specs, tasks) are not code work: the lead does them, following `/spectra-apply`, and tells the user.
- Tasks whose design decision is not written down: stop and have the user run `/spectra-ingest` first. BMAD's test: if different agents could implement it inconsistently, the artifacts are not specific enough. Do not "fix" this by implementing the task yourself.
- Never run two tasks that touch the same file at the same time.
- If a task cannot be dispatched for another reason (no Kiro, a dispatch keeps failing), ask the user before the lead implements it; doing it silently defeats the purpose of the skill.

## 2. Brief

Every dispatch gets a new nonce: `t<task-number>-<4 hex>` for implementation, `r<task-number>-<4 hex>` for review (the dot in the task number becomes `-`, e.g. `t1-2-a7f3`). Write `.herd/briefs/<nonce>.md`. The brief is the `/spectra-apply` **parallel worker packet** and must be self-contained:

```markdown
# Task <task-id> (<nonce>): <one-line summary>

## What to do
<the task's full text from tasks.md, verbatim>

## Basis
- Implementation Contract: <the excerpt for this task, verbatim>
- Spec: <relevant Requirement / Scenario / Example blocks, verbatim>
- Design: <relevant design.md decisions, verbatim>
- Completed prerequisites: <what the [after] tasks did and in which files>
- TDD rules: <only when tdd: true — the full text of `spectra instructions --skill tdd`>
- Audit lenses: <only when audit: true — Scoundrel (unsafe defaults), Lazy Developer (type confusion), Confused Developer (silent failure), each with one line on what to look for>

## Scope
- May modify or create: <file list>
- Must not modify: docs/spectra/**, .herd/briefs/**, files of other tasks

## Verification
<the task's verification commands, e.g. uv run pytest tests/test_x.py>
<for test tasks: temporarily break the code under test, confirm the new test fails, restore it, and report the failure summary plus `git diff -- <product path>` after restoring (must be empty)>
Run Python only through `uv run`, never the system Python.

## Rules
- Do not commit, push, edit tasks.md, or run any `spectra` command.
- If the spec or design is unclear or contradictory, stop and report; do not guess.

## Report
Write `.herd/results/<nonce>.json`: JSON only, no prose around it, matching `.claude/skills/herdr-spectra/schemas/worker-report.schema.json` (read it first; every field is required).
- `status`: `done`, or `blocked` with the decision you need in `blocked_question` (otherwise `null`).
- `deviations`: every place where the code departs from the literal spec or design text, and why. Empty when there are none.
- `break_checks`: for test tasks, what you broke, which tests failed, and whether the product file was restored. Empty otherwise.
- `scope_sha`: the output of `pwsh -NoProfile -File .claude/skills/herdr-spectra/scripts/scope-sha.ps1 <every file under "May modify or create">`, run as your last step.
Check the file with `pwsh -NoProfile -File .claude/skills/herdr-spectra/scripts/check-report.ps1 -Path .herd/results/<nonce>.json -Kind worker -Files <same files, comma-separated>` and fix it until it prints `"ok":true`.
Then reply in the chat with exactly one line: `HERD <nonce> report written`.
```

Workers cannot run `spectra`, so a bare `tdd=true` means nothing to them; paste the rules themselves. Copy spec and design text from the files (`grep -n '^###\|^####'` for line numbers, then `sed -n '<from>,<to>p'`); never retype it. Archived changes live in `docs/spectra/changes/archive/<date>-<name>/`.

The report is read from the **file**, not the screen; the chat line is only the completion signal: long replies may not fit an `agent read`, and `--lines` returns `agent_not_idle` while the agent works.

## 3. Spawn, dispatch, wait

### 3.0 Spawn a fresh agent per task

Never reuse an existing agent, including panes the user opened. Each task gets its own worker; rework rounds of the same task reuse that task's worker.

Spawn with the bundled script (run from the repo root):

```
pwsh -NoProfile -File .claude/skills/herdr-spectra/scripts/spawn-agent.ps1 -Name <name> -Model <model> -Change <change> -TaskId <task-id> [-FromPane <pane>]
```

It splits `-FromPane` toward its longer side, starts Kiro with `chat --trust-all-tools --model <model>`, waits until the screen shows Kiro's input prompt and the requested model, writes the `spawn` ledger line, and prints `{"name","pane_id","model"}`. On failure it exits 1 with the reason and leaves the pane open for inspection. Read the script for the details.

- **Name**: `w-<task-number>-<last 4 of nonce>` for workers, `r-…` for reviewers, e.g. `w-1-2-a7f3` (pattern `[a-z][a-z0-9_-]{0,31}`).
- **`-FromPane`**: omit it for the first agent (splits the lead's pane). For later agents pass the last spawned agent's pane, so the lead's own pane does not keep shrinking.
- **Model**: explicit, never `auto` (the script refuses it): with `auto` the server picks the model and the lead cannot tell which one ran. Defaults: `claude-sonnet-5.5` to implement, `gpt-5.6-terra` for a cross-vendor review; the user's choice wins. List models with `kiro-cli chat --list-models`.
- **Why the readiness check matters**: `agent start` can return `idle` while a dialog is on screen. Without the global setting from 0.3, `--trust-all-tools` shows a risk confirmation that herdr reads as `idle`, and answering it through `send-keys` is unreliable (Kiro ended the session in testing). The script stops with a clear error in that case; ask the user.
- **At most 3 agents at once.**

### 3.1 Dispatch

1. `spectra task start --change "<name>" <task-index>` to capture the Git baseline. `<task-index>` is the CLI's 1-based sequential index, not the `1.2` label; take it from the `spectra instructions apply` output.
2. `herdr agent get <name>` to confirm the agent is still there. A name disappears when its agent exits; on `agent_not_found`, read the pane to find out why instead of blindly respawning.
3. Send a one-line prompt that points at the brief:
   ```
   herdr agent prompt <name> "Read .herd/briefs/<nonce>.md and do what it says; the reporting rules are at the end." --wait --timeout 1800000
   ```
4. Ledger line: `<time> <task-id> <nonce> → <name> dispatched`.

### 3.2 Parallel tasks

Run parallel workers **in the main checkout**, one per task, only for tasks whose files and tests are disjoint (section 1). Send each prompt without `--wait`, then `herdr agent wait <name> --timeout …` for each. While any worker is working in the main checkout, the lead does not edit that worker's files.

Why not a worktree per worker: `herdr worktree create` branches from **HEAD**, and this workflow never commits, so a worktree would miss every completed-but-uncommitted prerequisite and the worker would build on stale code. Use worktrees only when the user asks, and then first carry the main checkout's uncommitted changes, untracked files included, into each new worktree. Note that `worktree create` opens a **new workspace** grouped with the repo's (find its root pane with `herdr pane list --workspace <id>` and pass it as `-FromPane`), and `worktree remove` keeps the branch.

### 3.3 Reading the wait result

| Result | Action |
|---|---|
| `idle` / `done` | Check that `.herd/results/<nonce>.json` exists. If yes, go to 4. If not, `herdr agent read <name> --source recent-unwrapped --lines 120` to see where it stopped, then nudge it or report to the user |
| `blocked` | The agent shows an approval or question dialog. Read it with `herdr agent read <name> --source visible` and **pass the decision to the user**; never answer for them. `herdr notification show "<name> needs input" --body "<summary>" --sound request` alerts them. The user can answer in the pane or tell the lead which option to press via `herdr agent send-keys`. Afterwards run `herdr agent wait <name> --timeout …` again, because the original `--wait` already returned. With `--trust-all-tools`, an approval dialog means auto mode did not take effect; check the start command instead of having the user approve repeatedly |
| `agent_prompt_stalled` / `timeout` | **This does not prove the prompt was not delivered. Never resend blindly.** Read the screen and check the report file first |
| `agent_blocked` (rejected before sending) | Same as `blocked` |

State reliability by agent:
- **Kiro, Claude**: reliable; `--wait` works directly.
- **Codex**: herdr's docs say Codex can stay `unknown` after it answers, so `--wait` may time out. Use `herdr pane wait-output <pane> --match "HERD <nonce>" --timeout …` or poll the report file.

## 4. Collect, check, review, triage

### 4.1 Worker report

Run `check-report.ps1 -Kind worker -Files <scope>` on it. Not ok (not JSON, schema error, stale `scope_sha`): send the errors to the same worker with the same nonce and ask for a corrected file; this does not count as a rework round. `status: blocked`: put `blocked_question` to the user, or, when the design already answers it, add the answer to the brief and resend with a new nonce.

### 4.2 Mechanical checks

These are the lead's own evidence, not a review. **Do not trust the worker's own account.** The diff is the evidence:
- `git status --short` and `git diff`. Any file outside the brief's scope, or missing from `files`, means the task goes back. With parallel workers the tree holds several tasks' changes at once; check each task against its own scope list.
- The lead runs the verification commands itself and compares the results with `verification`. For test tasks, the lead also repeats each `break_checks` entry (`git checkout -- <file>` restores committed code safely).
- Type-check touched files: `uv run --with pyright pyright <files>` (config in `pyrightconfig.json`; see DEVELOPMENT.md Q34).
- Mechanical failures (out-of-scope files, failing tests, type errors) go straight back to the worker (4.5) without spending a review on them.

### 4.3 Review

Spawn a reviewer (`r-…`, default `gpt-5.6-terra`) and dispatch a reviewer brief. It keeps the worker brief's title, Basis and Scope, adds the worker's `deviations` verbatim, and replaces What to do, Verification and Report with:

```markdown
## What to do
Review task <task-id> read-only: `git diff -- <scope files>`, plus any new files in scope. Modify no files and run no `spectra` command.
1. Spec conformance first: for every Scenario / Example and every Implementation Contract item in Basis, decide whether the code does it and whether a test pins it. A test counts only when it runs normally and an assertion observes the scenario's outcome; success-only, no-throw, mock-call or source-text checks do not count.
2. Then quality: naming, duplication, consistency with surrounding code, error paths, tests that exercise behavior, and whether each listed deviation is acceptable.
Report every finding, uncertain ones included. Do not filter and do not grade severity; put your uncertainty in `confidence`.

## Prior findings
<re-review only: the open F findings as a JSON array [{id, verdict, location, detail, fix}]; answer every one in `prior`>

## Report
Write `.herd/results/<nonce>.json`: JSON only, no prose around it, matching `.claude/skills/herdr-spectra/schemas/review-report.schema.json` (read it first; every field is required).
- `scope_sha`: `scope-sha.ps1` over the scope files, run before you start reading.
- `coverage`: one entry per Scenario / Example / contract item: `verified`, `partial` or `missing`, with `evidence` = `test file::name` and the asserting line, or the searches you ran.
- `findings`: ids `R1`, `R2`, …; `location` as `file:start-end`; `violates` names the spec scenario, contract item, design decision or AGENTS.md rule, or `none`; `trigger` and `consequence` one short line each (concrete input or state → wrong result).
Check the file with `check-report.ps1 -Kind review -Files <scope files, comma-separated> [-PriorIds <F ids>]` and fix it until it prints `"ok":true`.
Then reply in the chat with exactly one line: `HERD <nonce> report written`.
```

When it reports, run `check-report.ps1 -Kind review -Files <scope> [-PriorIds …]` yourself. Not ok: send the errors to the same reviewer once. A second failure means the review failed: write `review failed` to the ledger and spawn a new reviewer or ask the user. A failed review never counts as a pass.

### 4.4 Triage: check every reviewer result

The lead does not review the diff; it checks what the reviewer reported, one item at a time, and writes each outcome to `.herd/triage/<task-id>.md`. A decision that is not in that file does not exist.

1. **Wait for the whole report**, then copy every finding into the triage file as reported, with its `R` id and source `reviewer`. Do not merge anything yet.
2. **Check each finding's claim.** Can the cited behavior actually happen at the cited location? Read beyond the changed lines (callers, guards upstream) for a definite yes or no. Judge each finding on its own; never decide B because it resembles A. Severity, rarity and effort play no part in this step.
3. **Grade the real ones** by what one occurrence does, ignoring the reviewer's `confidence`:
   - `high`: data loss or corruption, a security exposure, a silently wrong result, a broken path with no workaround, or a violated MUST.
   - `medium`: wrong but noticed and worked around, limited in reach, or a spec scenario not done. When unsure between `medium` and `low`, pick `medium`.
   - `low`: cosmetic or a minor inconvenience. A finding with `violates: none` is `low` unless its consequence is itself high or medium.
   - `false`: not real; give what disproves it. `maybe-false`: settle it by running or reading more; if it stays open, ask the user before the task can pass.

   Every verdict gets one sentence of evidence.
4. **Check each coverage entry.** Open the cited evidence and confirm that the test runs normally and its assertion observes the scenario's outcome. A `verified` entry whose evidence does not hold, and every `partial` or `missing` entry, becomes a new `R` finding with source `coverage`, graded `medium`.
5. **Prior findings** (re-review): confirm every `resolved` against its evidence; one that does not hold, or is `open`, stays open.
6. Defects the lead runs into while checking go in as `R` findings with source `lead`. Do not go looking for more.
7. **Group by root cause** into `F` findings (`F1`, `F2`, …; numbering continues across rounds, and a new `R` with the root cause of an existing `F` joins it). An `F` carries the highest verdict of its members, their locations, the member `R` ids, and the fix. Rejected (`false`) findings stay in the file, marked rejected, with the reason.

One section per round:

```markdown
## Round <n>: review <nonce> (<model>), scope_sha <sha>
| R | source | location | claim | verdict | evidence |
| F | verdict | members | locations | detail | fix | status |
```

**The task passes** when no open `F` is `high` or `medium`, no `maybe-false` is unresolved, and the review passed 4.3's checks. `low` findings are fixed in the same rework round if there is one, otherwise listed in the final report.

### 4.5 Fail: rework

Append `## Round N feedback` to the original brief, holding the open `F` findings as a JSON array `[{id, verdict, location, detail, fix}]`, and send it with a new nonce to **the same task's worker**, which remembers its own work. Then the same reviewer re-reviews the new diff with those findings under Prior findings (and `-PriorIds` on the check). **At most 2 rounds per task**; after that ask the user.

### 4.6 Pass

- `spectra task done --change "<name>" <task-index> --file <path> [--file <path> …]`, listing every file of this task that the diff confirms. **Always pass `--file` for dispatched tasks**, even with a baseline: the baseline is the whole tree's state at `task start`, so anything else that changed meanwhile (another worker, the lead) would otherwise be attributed to this task. `/spectra-apply` asks for the same.
- Ledger line with the outcome and a triage summary (`F` count by verdict, rejected `R` count, open `low` ids), then clean up per section 6.

## 5. Close agents

Close each agent the lead spawned as soon as its task passes and its report has been read:

```
pwsh -NoProfile -File .claude/skills/herdr-spectra/scripts/close-agent.ps1 -Name <name> -Change <change>
```

The script closes the pane only when the ledger has its `spawn` line and the agent is `idle` or `done`, then writes the `close` ledger line. That ledger check is what keeps the user's own panes safe; do not close agents with a bare `herdr pane close`. When a task is handed to the user (BLOCKED, or more than 2 rework rounds), leave its agent open so the user can inspect it.

## 6. Clean up `.herd/`

The scratch files exist only to pass work between agents; they must not pile up.

- **When a task passes** (after `spectra task done` and its ledger line): delete every brief and report of that task, including rework rounds and reviews, and its triage file. The ledger line is the lasting record.
- **When the run ends** (every dispatched task is done, or the user stops the run): run `/spectra-apply` step 6, then delete `.herd/<change>.md`. Remove `.herd/` when it is empty.
- **Keep** the files of a task that is BLOCKED or handed to the user until it is resolved, and say so in the final report.
- Delete only files this skill created.

## 7. Final report

- A table: task → worker (model) → reviewer (model) → triage (`F` by verdict, rejected `R`) → rework rounds → result.
- Findings the lead rejected as `false`, each with its reason, so the user can overrule them.
- Open `low` findings that were not fixed.
- Progress from `spectra instructions apply --change "<name>" --json --summary`; when everything is done, recommend `/spectra-verify <name>` and `/spectra-review <name>` before `/spectra-archive`.
- What was cleaned up and anything intentionally left behind.

## Never

- Implement a code task yourself without asking the user first.
- Commit or push. Commits go through `/spectra-commit`, and only when the user asks.
- Answer an agent's approval or question dialog for the user.
- Let workers edit `docs/spectra/**` or run `spectra` commands.
- Keep dispatching after requirements change: stop and have the user run `/spectra-ingest`, then resume.
- Use Kiro's `auto` model, or change Kiro's global settings.
- Act on a report that `check-report.ps1` has not passed, or whose `scope_sha` is stale.
- Pass a task on the reviewer's word alone: every finding and coverage entry is checked in 4.4.
- Edit files a worker is working on while it works.
- Create workspaces, tabs, or worktrees without the user's consent. Spawning worker panes in 3.0 is part of this skill and needs no extra consent.
