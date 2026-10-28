# Agent Tools

## skills

| Skill | Description |
|-------|-------------|
| [herdr-spectra](skills/herdr-spectra/SKILL.md) | 透過 herdr 主導 Spectra change：每個任務派給新開的 Kiro worker，再由另一家模型的 Kiro reviewer 唯讀審查；主控（Claude）不自己審，而是逐項查證 reviewer 的發現與覆蓋證據（triage），依規則判定是否通過，再以 `spectra task done` 記錄完成並關閉 agent。agent 之間以 JSON 檔溝通（`schemas/`），並以 `scripts/check-report.ps1` 驗格式、`scripts/scope-sha.ps1` 防止報告過期。取自 server-install-wizard `00075ff`；以 Markdown 回報的舊版見本 repo commit `f5e5287`。 |
| [show-me](skills/show-me/SKILL.md) | 用精簡的視覺化內容協助理解目前主題：依情境呈現偽程式碼、呼叫樹、元件樹、檔案結構、Mermaid 流程圖或 diff；需要呈現較複雜的 UI、版面或概念時，則產生單頁 HTML 視覺稿。 |

### 外部

| Skill | Description |
|-------|-------------|
|[obra/superpowers](https://github.com/obra/superpowers)|提供 AI agent 技能框架與軟體開發方法論，協助以結構化流程執行開發任務。|
|[mattpocock/skills](https://github.com/mattpocock/skills)|Matt Pocock 整理的工程實務技能集，涵蓋日常軟體開發工作的指引。|
|[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)|為 AI coding agent 設計的生產級工程技能，協助提升實作與交付品質。|
|[QingYunA/answer-me-with-html](https://github.com/QingYunA/answer-me-with-html)|以單頁 HTML 呈現複雜問題的回答，讓內容更易閱讀與理解。|
|[DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)|以 YAGNI 原則引導 AI agent 只實作任務真正需要的內容，避免不必要的程式碼，同時保留驗證、錯誤處理、安全性與無障礙要求。|