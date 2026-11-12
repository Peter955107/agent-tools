# Capabilities and research sources

Researched 2026-11-12 against upstream Herdr. Runtime syntax must be checked against the installed CLI/server. This skill was authored outside Herdr; no live takeover was exercised.

| Capability | Contribution | Limit |
| --- | --- | --- |
| Workspace/tab/pane inventory | Find the source and its checkout | Focus is not identity; IDs are server-scoped. |
| Lifecycle detection | Decide when to communicate | Cannot prove completion or that children stopped. |
| Visible/recent-unwrapped reads | Recover UI, task clues and progress | Partial terminal evidence, not guaranteed chat export. |
| Foreground cwd/process inspection | Corroborate checkout and terminal occupant | Platform-dependent; pane cwd may differ. |
| Prompt and bounded wait | Request cooperative handoff | Settling does not identify a completed handoff turn. |
| Optional `agent_session` metadata | Identify an integration-reported native conversation | Not a universal cross-agent context export. |
| Saved-machine forwarding | Address the correct remote session | Does not provide local files or successor shell access. |
| Attachment `--takeover` | Replace a writable terminal controller | Does not transfer task, memory or file ownership. |

## Recovery distinctions

Client detach leaves pane processes alive. Server restart restores layout rather than original processes; eligible agents may resume native conversations through integrations. Configured screen replay restores output, not its original process. Verify current state before inferring the source is alive or stopped.

Native resume is specific to the agent and exact session reference. Avoid “resume latest”, duplicating a live conversation in a second writer, or blindly executing reported resume commands. A cross-agent successor reconstructs context from evidence. Do not install integrations or restart servers to recover missing history.

Missing methods are not permission to upgrade or stop servers. Optional schema and detection diagnostics help compatibility but are not prerequisites. `pane release-agent` releases a reporting source's lifecycle authority; it does not stop a process.

The ownership gate and evidence reconciliation are this skill's design. These CLI commands provide no transactional task-ownership transfer.

## Official sources

- [Upstream agent skill](https://github.com/herdrdev/herdr/blob/master/skills/herdr/SKILL.md): environment guard, identity and caller context.
- [CLI reference](https://herdr.dev/tui/docs/cli-reference/): syntax, foreground cwd, native-session metadata and controller attachment.
- [Agent automation](https://herdr.dev/tui/docs/agent-automation/): pane versus agent, identity and orchestration.
- [Socket API](https://herdr.dev/tui/docs/socket-api/): process inspection, waits and terminal reads.
- [Session state and restore](https://herdr.dev/tui/docs/session-state/): persistence, screen replay, native restore and server handoff.

## Cross-agent handoff research

Reviewed 2026-11-12. These are design references, not runtime dependencies; their skills and scripts were not installed or executed.

- [agent-session-resume](https://github.com/hacktivist123/agent-session-resume/blob/main/skills/agent-session-resume/SKILL.md): reconstruct the actual stopping point, attach evidence to task status, distinguish source claims from verified state, and report transcript/workspace mismatches. Its [evidence rules](https://github.com/hacktivist123/agent-session-resume/blob/main/skills/agent-session-resume/references/evidence-and-provenance.md) preserve user deferrals and their reopening conditions.
- [cskwork handoff](https://github.com/cskwork/agent-handoff/blob/main/handoff/SKILL.md): preserve unanswered user questions, exact commands/errors, decisions with rationale and a concrete immediate action. Its [receiver checklist](https://github.com/cskwork/agent-handoff/blob/main/handoff/ref/checklists/resume.md) checks revision drift and respects the user's latest intent.
- [Handover handoff](https://skills.handover.sh/handoff/SKILL.md): distinguish complete, active, blocked and unverified state; preserve failed attempts; verify that a cold reader can locate evidence and take the first bounded action. Local Markdown works without its optional publishing service.
- [WeirdSky924 agent-handoff](https://github.com/WeirdSky924/agent-handoff-skill/blob/main/SKILL.md): separate compact current state from decisions, validation and accumulated history for long-lived projects. This skill does not require that multi-file layout for a single takeover.
- [Anthropic long-running agent harness](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents): progress artifacts, Git history and startup verification support continuity across context windows. Its experiment-specific automatic commits and environment setup are not requirements of this takeover workflow.

Applied selectively: bounded recovery for the identified task instead of mandatory exhaustive history reads; explicit evidence gaps instead of promises of lossless transfer; preservation of the existing write-ownership gate. No extra confirmation is required merely because a handoff was received.
