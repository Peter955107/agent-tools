# herdr-agent-skills reference

Read the section you need; SKILL.md points here.

## Parallel tasks

- Only tasks whose dependencies (the task's `Depends` / `Dependencies` field, or the plan's dependency graph) are ticked done, and whose files and tests are disjoint; never two tasks touching the same file. A shared type file (e.g. `src/shared/types.ts`) counts as touching.
- `planning-and-task-breakdown` § Parallelization: features that share a contract need the contract task done first; migrations and shared state changes stay sequential.
- All workers share the main checkout. Dispatch each with `dispatch.ps1 … -NoWait`, then `herdr agent wait <name> --timeout 1800000` for each.
- Do not edit a working worker's files, and do not tick the todo file while any agent of the group is working; tick the group's passed tasks once they are all finished (SKILL.md 4.6).
- On every `guard-check.ps1` while others run, pass the other running tasks' scope files as `-Ignore`.
- Worktrees only when the user asks: `herdr worktree create` branches from HEAD, so first carry uncommitted changes (untracked included) into it; it opens a new workspace (find its root pane with `herdr pane list --workspace <id>` and pass it as `-FromPane`); its commits land on another branch; `worktree remove` keeps the branch.

## Wait results

| Result | Action |
|---|---|
| `idle` / `done` | Report file exists → SKILL.md 4. Otherwise `herdr agent read <name> --source recent-unwrapped --lines 120`, then nudge the agent or tell the user |
| `blocked` / `agent_blocked` | Read the dialog with `herdr agent read <name> --source visible`, alert the user (`herdr notification show "<name> needs input" --body "<summary>" --sound request`) and let them decide. Press keys with `herdr agent send-keys` only as they say. Then `herdr agent wait <name> --timeout …` again |
| `agent_prompt_stalled` / `timeout` | Not proof the prompt was lost. Read the screen and check the report file before resending |

Kiro and Claude Code report state reliably, so `--wait` works directly.

## Re-entry

After a context compaction or a restart, read `.herd/<change>.md` first, then the todo file. Never re-dispatch a task whose last ledger line is `dispatched`, `commit` or a review step; resume it from there. Tasks with a `done` line are finished; if their todo boxes are still unchecked (the lead was interrupted before 4.6), tick them now. A checkpoint with unchecked review items means the user has not passed it yet: ask before continuing.
