# Agent Tools

## skills

| Skill | Description |
|-------|-------------|
| [herdr-spectra](skills/herdr-spectra/SKILL.md) | 透過 herdr 主導 Spectra change：每個任務派給新開的 Kiro worker，再由主控（Claude）與另一家模型的 Kiro reviewer 各審一次，兩邊都通過才以 `spectra task done` 記錄完成，最後關閉 agent。附 `scripts/spawn-agent.ps1`、`scripts/close-agent.ps1`。此為 agent 之間以 Markdown 回報（`STATUS:` 首行）的舊版，取自 server-install-wizard `bbff9f0`。 |