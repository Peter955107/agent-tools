# Agent Tools

## skills

| Skill | Description |
|-------|-------------|
| [herdr-spectra](skills/herdr-spectra/SKILL.md) | 透過 herdr 主導 Spectra change：每個任務派給新開的 Kiro worker，再由另一家模型的 Kiro reviewer 唯讀審查；主控（Claude）不自己審，而是逐項查證 reviewer 的發現與覆蓋證據（triage），依規則判定是否通過，再以 `spectra task done` 記錄完成並關閉 agent。agent 之間以 JSON 檔溝通（`schemas/`），並以 `scripts/check-report.ps1` 驗格式、`scripts/scope-sha.ps1` 防止報告過期。取自 server-install-wizard `00075ff`；以 Markdown 回報的舊版見本 repo commit `f5e5287`。 |