---
name: herdr-spectra
description: Lead a Spectra change through herdr so the coding work runs on other AI subscriptions instead of this session. Every task goes to a fresh Kiro agent (explicit model) in a new herdr pane; each result gets two independent reviews, one by this session (Claude) and one by a different-vendor model in Kiro; tasks are recorded with spectra task start/done and the agents are closed afterwards. Use this whenever a Spectra change is to be implemented or reviewed and the user wants other agents involved, even without saying "herdr" - e.g. Kiro, Codex, worker or reviewer agents, delegating tasks, multi-agent or parallel agents, "let another model review it", or Chinese like 分派、派給 Kiro、開 agent 來做、多 agent 協作、讓別的模型審查. Prefer it over /spectra-apply in those cases. Not for applying a change alone, and not for plain herdr pane/layout questions with no Spectra change (use the herdr skill).
---

# herdr + Spectra

This session is the **lead**. For each task the lead spawns a fresh **worker** that implements it and a fresh **reviewer** that reviews it read-only, verifies the work, and closes both. Default agent: **Kiro** in auto mode with an explicit model. Use another kind only when the user names one.

**Why this skill exists**: to spread usage across the user's AI subscriptions and to get two independent AI reviews of every task. The lead's own usage is the scarce resource, so the lead orchestrates, reads diffs, runs checks, and reviews, but does not write the implementation. Every task gets two reviewers from different vendors: the lead (Claude) and a Kiro reviewer on a non-Claude model.

This skill wraps `/spectra-apply`'s setup and bookkeeping and replaces its implementation step. Spectra rules still hold: `tasks.md` checkboxes are task truth, and only the lead attributes tasks (`spectra task start` / `spectra task done`). Workers never run them.

For generic herdr rules (IDs come from JSON, `--no-focus`, never close what you did not create, never `herdr server stop`, `--trust-repository` only after the user verifies the repo), follow the `herdr` skill. Load it first.

Respond to the user in the language AGENTS.md requires.

Sources of the design: BMAD (self-contained story, reviewer on a different LLM), Superpowers (spec review before quality review), BMAD party mode `subagent` (independent agents instead of one mind voicing every side), Claude Squad (one isolated agent per task).

## 0. Preconditions

1. `HERDR_ENV` must be `1`; otherwise say the session is not inside herdr and stop.
2. **Spectra CLI**: use `spectra` if it is on PATH, else `$LOCALAPPDATA/Spectra/spectra.exe`. If neither works, report it and stop.
3. **Kiro auto mode**: `kiro-cli settings list` must show `chat.disableTrustAllConfirmation = true (global)`. If it is missing, stop and ask the user; never change Kiro settings yourself. The setting cannot be set per workspace.
4. **Run `/spectra-apply` steps 1–4 as written**: select the change and announce "Using change: <name>", check status/parking, `spectra instructions apply --change "<name>" --json --compact`, `spectra analyze`, drift when dormancy is triggered, and read `.spectra.yaml` (`tdd`, `audit`). Dispatch starts only where `/spectra-apply` step 5 would start implementing.
5. **Scratch directory `.herd/`** at the repo root, excluded through `.git/info/exclude` (local only, so `.gitignore` stays untouched). Add the `.herd/` line if it is missing. Layout:
   ```
   .herd/<change>.md          ledger: one line per spawn, dispatch, report, review, close, cleanup
   .herd/briefs/<nonce>.md    task brief
   .herd/results/<nonce>.md   report written by the worker
   ```
   On re-entry (for example after context compaction), read the ledger first and never re-dispatch a task that is in flight or done. Section 6 defines when these files are deleted.

## 1. Plan the dispatch

**Every pending task is dispatched by default.** Before starting, show the user a plan: each task → worker model → reviewer model, and which tasks run in parallel.

- **Order**: follow task order; tasks whose `[after: …]` prerequisites are all done and whose files and tests are disjoint may run in parallel (3.2). This is the grouping `/spectra-apply` step 4 defines.
- **Default models**: worker `claude-sonnet-5.5`; external reviewer `gpt-5.6-terra`, so the two reviews come from different vendors. The user's choices win. If the user changes the worker to a non-Claude model, pick the external reviewer from another vendor still.

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
Write the report to `.herd/results/<nonce>.md`:
line 1 `STATUS: DONE` or `STATUS: BLOCKED`; then every touched file, the tests added or changed, and verification results. For BLOCKED, say where you are stuck and what decision you need.
Last line: `MODEL: <the model you are running>`.
Then reply in the chat with exactly one line: `HERD <nonce> report written`.
```

Workers cannot run `spectra`, so a bare `tdd=true` means nothing to them; paste the rules themselves. Copy spec and design text from the files (`grep -n '^###\|^####'` for line numbers, then `sed -n '<from>,<to>p'`); never retype it. Archived changes live in `docs/spectra/changes/archive/<date>-<name>/`.

The report is read from the **file**, not the screen: long replies may not fit an `agent read`, and `--lines` returns `agent_not_idle` while the agent works.

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
| `idle` / `done` | Check that `.herd/results/<nonce>.md` exists. If yes, go to 4. If not, `herdr agent read <name> --source recent-unwrapped --lines 120` to see where it stopped, then nudge it or report to the user |
| `blocked` | The agent shows an approval or question dialog. Read it with `herdr agent read <name> --source visible` and **pass the decision to the user**; never answer for them. `herdr notification show "<name> needs input" --body "<summary>" --sound request` alerts them. The user can answer in the pane or tell the lead which option to press via `herdr agent send-keys`. Afterwards run `herdr agent wait <name> --timeout …` again, because the original `--wait` already returned. With `--trust-all-tools`, an approval dialog means auto mode did not take effect; check the start command instead of having the user approve repeatedly |
| `agent_prompt_stalled` / `timeout` | **This does not prove the prompt was not delivered. Never resend blindly.** Read the screen and check the report file first |
| `agent_blocked` (rejected before sending) | Same as `blocked` |

State reliability by agent:
- **Kiro, Claude**: reliable; `--wait` works directly.
- **Codex**: herdr's docs say Codex can stay `unknown` after it answers, so `--wait` may time out. Use `herdr pane wait-output <pane> --match "HERD <nonce>" --timeout …` or poll the report file.

## 4. Collect, verify, and review twice

1. Read `.herd/results/<nonce>.md`. `STATUS: BLOCKED`: put the question to the user, or, when the design already answers it, add the answer to the brief and resend with a new nonce.
2. **Do not trust the worker's own account.** The diff is the evidence:
   - `git status --short` and `git diff`. Any file outside the brief's scope means the task goes back. With parallel workers the tree holds several tasks' changes at once; check each task against its own scope list.
   - The lead runs the verification commands itself. For test tasks, the lead also breaks and restores the code under test (`git checkout -- <file>` restores committed code safely).
   - Type-check touched files: `uv run --with pyright pyright <files>` (config in `pyrightconfig.json`; see DEVELOPMENT.md Q34).
   - Mechanical failures (out-of-scope files, failing tests, type errors) go straight back to the worker (step 5) without spending reviews on them.
3. **External review**: spawn a reviewer (`r-…`, default `gpt-5.6-terra`) and dispatch a reviewer brief. It uses the same template, but "What to do" becomes "Review the diff of <task-id> read-only (`git diff -- <files>`); check spec conformance first, then quality; modify no files", and the report's line 1 becomes `STATUS: PASS` or `STATUS: FAIL`, with findings marked Critical / Major / Minor. **A PASS must carry evidence**: each spec scenario checked and the test or line that covers it, and the quality aspects examined. In testing, `gpt-5.6-terra` answered only "no issues" when not asked for evidence; send such a report back.
4. **Lead review, while the external reviewer works** (form your own view before reading theirs, so the two reviews stay independent):
   - Stage 1, spec conformance: the spec scenarios, the Implementation Contract, and the design. Do not start stage 2 until it passes.
   - Stage 2, code quality: naming, duplication, consistency with surrounding code, tests that exercise behavior.
5. **Merge the two reviews.** The task passes only when both pass. Any Critical or Major finding from either reviewer fails it. When the reviewers disagree, check the disputed point against the code and the spec yourself and record the ruling and its reason in the ledger; do not just side with yourself. Minor findings are fixed in the same rework round if there is one, otherwise listed in the final report.
6. **Fail**: append the findings (with which reviewer raised each) to the original brief under "## Round N feedback" and send it with a new nonce to **the same task's worker**, which remembers its own work. Both reviewers re-review the new diff, and the external reviewer gets its earlier report so it can check its own points. **At most 2 rounds per task**; after that ask the user.
7. **Pass**:
   - `spectra task done --change "<name>" <task-index> --file <path> [--file <path> …]`, listing every file of this task that the diff confirms. **Always pass `--file` for dispatched tasks**, even with a baseline: the baseline is the whole tree's state at `task start`, so anything else that changed meanwhile (another worker, the lead) would otherwise be attributed to this task. `/spectra-apply` asks for the same.
   - Ledger line with the outcome, then clean up per section 6.

## 5. Close agents

Close each agent the lead spawned as soon as its task passes and its report has been read:

```
pwsh -NoProfile -File .claude/skills/herdr-spectra/scripts/close-agent.ps1 -Name <name> -Change <change>
```

The script closes the pane only when the ledger has its `spawn` line and the agent is `idle` or `done`, then writes the `close` ledger line. That ledger check is what keeps the user's own panes safe; do not close agents with a bare `herdr pane close`. When a task is handed to the user (BLOCKED, or more than 2 rework rounds), leave its agent open so the user can inspect it.

## 6. Clean up `.herd/`

The scratch files exist only to pass work between agents; they must not pile up.

- **When a task passes** (after `spectra task done` and its ledger line): delete every brief and report of that task, including rework rounds and reviews. The ledger line is the lasting record.
- **When the run ends** (every dispatched task is done, or the user stops the run): run `/spectra-apply` step 6, then delete `.herd/<change>.md`. Remove `.herd/` when it is empty.
- **Keep** the files of a task that is BLOCKED or handed to the user until it is resolved, and say so in the final report.
- Delete only files this skill created.

## 7. Final report

- A table: task → worker (model) → external reviewer (model) → lead verdict → rework rounds → result, plus any reviewer disagreements and how they were ruled.
- Open Minor findings that were not fixed.
- Progress from `spectra instructions apply --change "<name>" --json --summary`; when everything is done, recommend `/spectra-verify <name>` and `/spectra-review <name>` before `/spectra-archive`.
- What was cleaned up and anything intentionally left behind.

## Never

- Implement a code task yourself without asking the user first.
- Commit or push. Commits go through `/spectra-commit`, and only when the user asks.
- Answer an agent's approval or question dialog for the user.
- Let workers edit `docs/spectra/**` or run `spectra` commands.
- Keep dispatching after requirements change: stop and have the user run `/spectra-ingest`, then resume.
- Use Kiro's `auto` model, or change Kiro's global settings.
- Edit files a worker is working on while it works.
- Create workspaces, tabs, or worktrees without the user's consent. Spawning worker panes in 3.0 is part of this skill and needs no extra consent.
