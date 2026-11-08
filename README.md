# Agent Tools

## skills

| Skill | Description |
|-------|-------------|
| [herdr-spectra](skills/herdr-spectra/SKILL.md) | 透過 herdr 主導 Spectra change：開始前讓使用者選擇 worker 與 reviewer 用的 agent 與模型（Kiro 或 Claude Code，預設皆為 Kiro）；每個任務派給新開的 worker，完成後先 commit，再由 reviewer 以全權限審查並測試；主控（Claude）不自己審，而是逐項查證 reviewer 的發現與覆蓋證據（triage），依規則判定是否通過，再以 `spectra task done` 記錄完成並關閉 agent。agent 之間以 JSON 檔溝通（`schemas/`），並以 `scripts/check-report.ps1` 驗格式、`scripts/scope-sha.ps1` 防止報告過期。取自 server-install-wizard `00075ff`；以 Markdown 回報的舊版見本 repo commit `f5e5287`。 |
| [herdr-agent-skills](skills/herdr-agent-skills/SKILL.md) | 透過 herdr 執行 [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) 的計畫（`tasks/spec.md`、`tasks/plan.md`、`tasks/todo.md`）。架構沿用 herdr-spectra：每個任務派給新開的 worker 實作，worker 依 `incremental-implementation` 與 `test-driven-development` 工作；完成後先 commit，再由不同廠商的 reviewer 依 `code-review-and-quality` 審查並測試；主控逐項 triage reviewer 的發現，通過才勾選 `todo.md`。遇到 checkpoint 一律停下來交給人審。agent 不得修改 spec 和 plan，由 `scripts/guard-check.ps1` 事後檢查。 |
| [show-me](skills/show-me/SKILL.md) | 用精簡的視覺化內容協助理解目前主題：依情境呈現偽程式碼、呼叫樹、元件樹、檔案結構、Mermaid 流程圖或 diff；需要呈現較複雜的 UI、版面或概念時，則產生單頁 HTML 視覺稿。 |

## mods

Claude Code mods（以 hooks module 改變 Claude Code 介面或行為的 plugin）。

| Mod | Description |
|-----|-------------|
| [usage-box](mods/usage-box/hooks/register.tsx) | 在輸入框上方顯示 5 小時與本週方案用量、context 用量：圓角進度條、時間進度刻度、重置倒數，70% 轉橘、90% 轉紅；用量到 80%、90% 時以 toast 提醒並預估用完時間。按「收合」改在狀態列顯示一行小字，`/usage-box` 叫回。需 Pro / Max 訂閱。 |

## 本地安裝

每個 skill 與 mod 都是獨立的 plugin，可只裝需要的。直接讀這個資料夾，改檔後 `/reload-plugins` 即生效。

```
claude plugin marketplace add <agent-tools 資料夾路徑>

claude plugin install usage-box@agent-tools
claude plugin install show-me@agent-tools
claude plugin install herdr-spectra@agent-tools
claude plugin install herdr-agent-skills@agent-tools
```

停用或移除單一功能：`claude plugin disable <名稱>@agent-tools`、`claude plugin uninstall <名稱>@agent-tools`。

### 外部

| Skill | Description |
|-------|-------------|
|[obra/superpowers](https://github.com/obra/superpowers)|提供 AI agent 技能框架與軟體開發方法論，協助以結構化流程執行開發任務。|
|[mattpocock/skills](https://github.com/mattpocock/skills)|Matt Pocock 整理的工程實務技能集，涵蓋日常軟體開發工作的指引。|
|[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)|為 AI coding agent 設計的生產級工程技能，協助提升實作與交付品質。|
|[QingYunA/answer-me-with-html](https://github.com/QingYunA/answer-me-with-html)|以單頁 HTML 呈現複雜問題的回答，讓內容更易閱讀與理解。|
|[DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)|以 YAGNI 原則引導 AI agent 只實作任務真正需要的內容，避免不必要的程式碼，同時保留驗證、錯誤處理、安全性與無障礙要求。|
|[vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)|為 AI agent 提供瀏覽器環境，使其能夠與 Web 內容進行互動。|
|[tt-a1i/archify](https://github.com/tt-a1i/archify)|將任何想法、計畫或程式碼庫轉化為精美的互動式圖表。適用於 Claude Code、Codex 等平台的代理技能。|

## 工具

|Tool|Description|
|------|-------------|
|[impeccable.style](https://impeccable.style)|提供一致的設計系統和樣式指南，協助開發者快速建立美觀且一致的用戶界面。|
|[openui](https://www.openui.com/)|提供豐富的 UI 元件和設計資源，幫助開發者快速建構現代化的用戶界面。|

