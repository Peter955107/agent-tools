# usage-sentinel 任務清單

> 詳細的驗收條件與驗證步驟見 `tasks/plan.md`。測試指令：`node --test`。

## 第一階段：骨架與注入
- [x] 任務 1：plugin 骨架、gate.mjs 停用開關、SessionStart 建立資料夾與預設設定（M）
- [x] 任務 2：state.mjs，包含設定驗證、原子寫入、mkdir 鎖（S）
- [x] 任務 3：fake-usage → 正規化 → 分段 → PreToolUse 注入（每段一次、跳過 subagent）（M）
- [ ] **檢查點 1**：VS Code 實機，fake 80% 看到注入；`DISABLED` 存在時完全靜默

## 第二階段：真實用量資料
- [x] 任務 4：usage 端點輪詢，含 poll.lock、429／401／逾時／格式錯誤處理，搭配假 HTTP server 測試（M）
- [x] 任務 5：來源合併、新鮮度、七種不可用原因、UserPromptSubmit 注入（S–M）
- [x] 任務 6：`/usage-sentinel status | on | off | set`（S）
- [ ] **檢查點 2**：status 顯示真實數字；429 時不阻擋（驗收 8）

## 第三階段：停止與詢問
- [ ] 任務 7：dialog.mjs（Windows WinForms）與 `test-dialog`（S）
- [ ] 任務 8：觸發停止、prompt.lock、decision.json、繼續（snooze）或停止、events.log（M）
- [ ] 任務 9：已停止狀態、收尾模式、允許清單、`resume`／`snooze` 指令（M）
- [ ] 任務 10：ask 備援、PostToolUse 核准偵測、無人值守時直接停止（S）
- [ ] 任務 11：自我保護（狀態資料夾、credentials、uninstall 輸出 ask）（S）
- [ ] **檢查點 3**：驗收 1–10、15、16 通過

## 第四階段：周邊與移除
- [ ] 任務 12：桌面 toast 與 webhook 通知（S）
- [ ] 任務 13：SessionStart 複製 bin/、寫 manifest；statusline.mjs 串接；install-statusline.mjs（M）
- [ ] 任務 14：uninstall.mjs 本機部分（statusLine 還原、狀態資料夾、冪等、dry-run／yes／purge）（M）
- [ ] 任務 15：uninstall.mjs 的 Claude Code 部分（執行中程序預檢、各範圍 plugin、市集、cache、設定差異、往返測試）（M）
- [ ] 任務 16：README；macOS／Linux 對話框（次要）（S）
- [ ] **檢查點 4**：驗收 1–21 全部通過，人工審閱後才算完成

## 開始前需要你回覆的待決問題
- [ ] 1. 是否接受測試用的 `USAGE_SENTINEL_ENDPOINT`（只在設了 `USAGE_SENTINEL_DIR` 時生效）
- [ ] 2. 本 repo 是否兼作市集，以及市集名稱
- [ ] 3. macOS／Linux 對話框是否納入 v1
- [ ] 4. 「收尾已完成」的判定方式
