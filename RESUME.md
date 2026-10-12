# 接續筆記（2026-10-12，5 小時用量 85% 時收尾）

分支：`feature/usage-sentinel-v2`，最新 commit `b2d27fc`，版本 0.3.5。測試：`node --test`，395 個全數通過。
計畫：`tasks/plan.md`；進度：`tasks/todo.md`。

## 已完成
- 第一～三階段（任務 1–11）全部完成，檢查點 1–3 已由使用者在 VS Code 實機確認。
- 任務 12：桌面 toast 與 webhook（toast 的 PowerShell 回傳 exit 0，**畫面上有沒有出現尚待使用者確認**）。
- 任務 13：statusline.mjs（單一自足檔）、SessionStart 複製 bin/ 與 manifest、install-statusline。

## 下一步
1. 任務 14：`scripts/uninstall.mjs` 本機部分（FR-8 步驟 1、2、3、4、8、9 與 8.5 本機檢查；`--yes`／`--dry-run`／`--purge`；冪等）。
   - 必須是**單一自足檔案**（會被 SessionStart 複製到 `bin/`；`BIN_FILES` 已包含它，檔案存在後自動複製）。
   - statusLine 還原依 `manifest.statusline.command`／`original`；使用者已改過就不動並提示。
2. 任務 15：uninstall 的 Claude Code 部分（執行中程序預檢、`claude plugin list/uninstall` 各範圍、市集、cache、設定差異、隔離 `CLAUDE_CONFIG_DIR` 往返測試）。
3. 任務 16：README（含已知限制、只用 `claude plugin uninstall` 會留下什麼、指令名稱是 `/usage-sentinel:usage-sentinel`）。

## 未完成／待確認
- statusLine 的 `rate_limits` 欄位格式（`five_hour.used_percentage`／`resets_at`）是依需求書推測，**尚未在終端機 CLI 實測**（需求書 §9、U4）。
- plugin 以本機資料夾安裝（`readFromFolder`），hook 直接執行 repo 內的檔案：修改中途的不一致狀態可能讓 hook 出錯（會 fail-open，記到 `errors.log`）。新模組先寫好、最後才接進 handler。
- 這個 session 也受自我保護約束：Bash 指令提到 `~/.claude/usage-sentinel` 會被擋，查狀態檔請用 Read 工具。
