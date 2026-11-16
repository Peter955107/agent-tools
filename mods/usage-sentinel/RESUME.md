# 接續筆記（2026-10-12，5 小時用量 95% 時收尾）

分支：`feature/usage-sentinel-v2`，最新 commit `69d02e9`，版本 0.3.9。
測試：`node --test`，425 個通過、1 個略過（真實 CLI 往返測試，需 `USAGE_SENTINEL_E2E=1`）。
計畫：`tasks/plan.md`；進度：`tasks/todo.md`。

## 已完成
- 任務 1–15 全部完成；檢查點 1–3 已由使用者實機確認。
- 任務 14–15：`scripts/uninstall.mjs`（單一自足檔，SessionStart 複製到 `bin/`）
  - 步驟 0–10 全部實作；`--yes`／`--dry-run`／`--purge`／`--force`／`--skip-claude`
  - 殘留自我檢查 ✅／⏳／⚠️；設定差異報告
  - 真實 CLI 往返測試（隔離 `CLAUDE_CONFIG_DIR`）已實測通過
- `/usage-sentinel:usage-sentinel uninstall [--yes]`：不加 `--yes` 只列清單。

## 下一步
1. 任務 16：`README.md`
   - 安裝（本機市集：`claude plugin marketplace add <repo>`、`claude plugin install usage-sentinel@usage-sentinel`）
   - 指令名稱是 `/usage-sentinel:usage-sentinel <子指令>`（plugin 前綴）
   - 設定（§5 各鍵與驗證規則）、通知（wind-down／stop 時）、statusLine 選配（只有終端機 CLI）
   - 移除：主要方式 `node ~/.claude/usage-sentinel/bin/uninstall.mjs`；只用 `claude plugin uninstall` 會留下 statusLine、狀態資料夾、市集宣告、plugin cache
   - 已知限制：未公開端點、VS Code 不執行 statusLine、`-p` 無法用 slash command 移除、自我保護是盡力而為的字串比對、對話框只支援 Windows（其他平台改用 ask）
   - 測試：`node --test`；E2E：`USAGE_SENTINEL_E2E=1 node --test test/e2e-roundtrip.test.mjs`
2. 檢查點 4：驗收 12、13、16–20 在使用者實機上確認（移除會動到真實設定，需使用者決定時機）。
3. 待使用者決定：macOS／Linux 對話框是否做（待決問題 3，目前回傳 unavailable → ask 備援）。

## 未完成／待確認
- statusLine 的 `rate_limits` 格式尚未在終端機 CLI 實測（需求書 §9、U4）。
- 完整測試偶爾因 Windows 虛擬記憶體不足（exit 0xC000012D）失敗：`node --test` 平行跑太多子程序。重跑即通過；若常發生可改用 `node --test --test-concurrency=2`。
- plugin 以本機資料夾安裝（`readFromFolder`），hook 直接執行 repo 內檔案：新模組先寫好、最後才接進 handler。
