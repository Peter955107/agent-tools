# 實作計畫：usage-sentinel v2

> 依據：`docs/usage-sentinel-需求書.md`（v2）、`docs/假設驗證與需求衝突.md`。
> 文中 FR-#／A#／C#／E# 代號同需求書；「驗收 #」指需求書 §7 的驗收條件編號。

## 概觀

做一個 Claude Code plugin。它在每次 PreToolUse／UserPromptSubmit 時，惰性輪詢 `/api/oauth/usage`，取得官方用量。然後依 warn／wind-down／stop 三段門檻做這些事：

- 注入用量資訊與收尾指示
- 跳出 WinForms 對話框讓使用者決定是否繼續
- 選「停止」後進入收尾模式：只放行 commit 與接續筆記，最後停下

另外提供 slash command、選配的 statusLine，以及能在 Claude Code 外執行、不留殘留的一鍵移除。

目前 repo 只有文件，沒有任何程式碼。

## 架構決策

| 決策 | 理由 |
|---|---|
| repo 根目錄就是 plugin 根目錄（`.claude-plugin/`、`hooks/`、`scripts/`、`commands/`、`test/` 直接放在根目錄） | 需求書 §8 的交付樹以 `usage-sentinel/` 為根，正好就是本 repo |
| 只用 Node ≥ 18 內建模組；測試用 `node:test` + `node:assert`，指令 `node --test` | 需求書規定不使用外部套件，不引入測試框架 |
| 所有 hook 腳本的第一行 import 同一個極小的 `gate.mjs`（檢查資料夾存在、`DISABLED`、`USAGE_SENTINEL_DISABLE`），之後才 import 其他模組 | FR-8.1 規定這個檢查要在所有讀檔、解析、網路請求之前；即使其他模組有語法錯誤，也能停用 |
| 每個 hook 都包一層 top-level try/catch：例外時 exit 0、不輸出決策，並寫入 `errors.log`。唯一例外是已確定的「停止」狀態，照常輸出 deny | §6 的 fail-open 原則；C3 |
| 狀態資料夾可用 `USAGE_SENTINEL_DIR` 覆寫，`fake-usage.json` 優先於網路 | §7 測試資料注入 |
| **新增**測試用環境變數 `USAGE_SENTINEL_ENDPOINT`，用來覆寫 usage 端點 URL，只在同時設了 `USAGE_SENTINEL_DIR` 時生效 | 整合測試需要假 HTTP server；限制生效條件，避免正式環境被導到別處而外洩 token（見待決問題 1） |
| 純邏輯（分段、正規化、合併、snooze、允許清單、自我保護）都寫成無副作用的函式，與 I/O 分開 | 方便單元測試；hook 腳本只負責組裝 |
| 「收尾已完成」的判定：在已停止狀態下，PostToolUse 觀察到允許清單內的 `git commit` 成功，**且**觀察到對 `resume_file` 的 Write／Edit，就記錄在 `stopped.json` 裡 | FR-4.6 需要這個判定；hook 本身無法直接得知 commit 是否成功 |
| 時間計算一律用 epoch 秒；ISO 時間（含微秒）在正規化階段就轉換 | FR-1 正規化 |

## 相依關係圖

```
gate.mjs（停用開關、路徑）
  └─ state.mjs（設定驗證、原子寫入、mkdir 鎖、session 紀錄）
       ├─ tiers.mjs（純邏輯：分段、snooze、允許清單、自我保護）
       ├─ usage.mjs（fake → 端點輪詢 → 正規化 → 合併 → 快取）
       │     └─ guard.mjs（PreToolUse）── dialog.mjs
       │     └─ prompt.mjs（UserPromptSubmit）
       │     └─ post.mjs（PostToolUse）
       │     └─ cli.mjs ── commands/usage-sentinel.md
       │     └─ statusline.mjs ── install-statusline.mjs
       └─ session-start.mjs（建立資料夾、預設設定、bin/ 複製、manifest）
                └─ uninstall.mjs（讀 manifest，可獨立執行，只依賴 Node 內建模組）
```

`uninstall.mjs` 必須是**單一自足檔案**。它會被複製到 `bin/`，在 plugin 已刪除時也要能跑，所以不能 import `scripts/` 底下的其他模組。

## 任務清單

### 第一階段：骨架與注入（最先能看到效果）
- 任務 1：plugin 骨架與停用開關（各 hook 先做成 no-op）
- 任務 2：state.mjs，包含設定驗證、原子寫入、mkdir 鎖
- 任務 3：用 fake-usage 走通分段判斷，PreToolUse 注入 warn／wind-down

**檢查點 1**：在 VS Code 實際安裝。fake 80% 時看到注入；建立 `DISABLED` 後完全靜默。

### 第二階段：真實用量資料
- 任務 4：usage 端點輪詢，含鎖、退避、錯誤分類
- 任務 5：來源合併、新鮮度判斷、不可用原因，以及 UserPromptSubmit 注入
- 任務 6：slash command 的 status／on／off／set

**檢查點 2**：VS Code 裡 `/usage-sentinel status` 顯示真實百分比；假 server 回 429 時不阻擋，並顯示退避中（驗收 8）。

### 第三階段：停止與詢問（核心，風險最高）
- 任務 7：dialog.mjs（Windows）與 `test-dialog`
- 任務 8：觸發停止、決策鎖、繼續或停止、snooze
- 任務 9：已停止狀態與收尾模式，加上 resume／snooze 指令
- 任務 10：ask 備援、PostToolUse 核准偵測、無人值守
- 任務 11：自我保護（FR-4.8）

**檢查點 3**：驗收 1–10、15 全部通過（在 VS Code 實機跑）。

### 第四階段：周邊與移除
- 任務 12：桌面通知與 webhook
- 任務 13：SessionStart 複製 bin/、寫 manifest；statusline.mjs 與 install-statusline.mjs
- 任務 14：uninstall.mjs 本機部分（停用開關、statusLine 還原、狀態資料夾、冪等、自我檢查）
- 任務 15：uninstall.mjs 的 Claude Code 部分（各範圍 plugin、市集、cache、執行中程序預檢、設定差異）
- 任務 16：README；macOS／Linux 對話框（次要）

**檢查點 4（完成）**：驗收 1–21 全部通過，並由人審閱。

## 各任務細節

### 任務 1：plugin 骨架與停用開關
**說明**：建立 plugin 結構，讓 Claude Code 能載入。四個 hook 都先做成 no-op。實作 `gate.mjs`，並讓 SessionStart 建立狀態資料夾與預設 `config.json`。

**驗收條件**
- [ ] `hooks.json` 註冊以下四個 hook，全部透過 `${CLAUDE_PLUGIN_ROOT}` 呼叫 node：
  - PreToolUse（`*`，150s）
  - PostToolUse（`*`，10s）
  - UserPromptSubmit（10s）
  - SessionStart（10s）
- [ ] 狀態資料夾不存在、`DISABLED` 存在、或 `USAGE_SENTINEL_DISABLE=1` 時，非 SessionStart 的 hook 會 exit 0、沒有輸出，也**不會建立資料夾**
- [ ] SessionStart 會建立資料夾，並在 `config.json` 不存在時寫入預設值

**驗證**
- [ ] `node --test test/gate.test.mjs`
- [ ] 手動：用本機市集安裝到 VS Code，開新 session 呼叫工具，確認 `~/.claude/usage-sentinel/config.json` 出現，而且沒有其他副作用

**相依**：無
**檔案**：`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`hooks/hooks.json`、`scripts/gate.mjs`、`scripts/{guard,post,prompt,session-start}.mjs`、`test/gate.test.mjs`
**規模**：M

### 任務 2：state.mjs，包含設定驗證、原子寫入、mkdir 鎖
**說明**：實作所有共用的狀態原語。

**驗收條件**
- [ ] `loadConfig` 會合併預設值，並依 §5 規則驗證；不合法時回傳錯誤訊息清單
- [ ] `atomicWrite`：先寫暫存檔再 rename。遇到 EPERM／EBUSY 重試 5 次、間隔 20–50ms 隨機；仍失敗就回傳 false，不丟例外
- [ ] `acquireLock(name)` 用 mkdir，並記錄 PID 與時間；超過 TTL 的鎖可以回收；搶不到時立即回傳 false

**驗證**
- [ ] `node --test test/state.test.mjs`：涵蓋門檻順序、邊界值、死鎖回收，以及多程序搶鎖時恰好一個成功

**相依**：1
**檔案**：`scripts/state.mjs`、`test/state.test.mjs`
**規模**：S

### 任務 3：用 fake-usage 走通分段判斷與 PreToolUse 注入
**說明**：這是第一個端到端的切片。讀 `fake-usage.json`，正規化後算出分段；主 agent 的 PreToolUse 透過 `additionalContext` 注入；每個 session 的每個分段只注入一次。

**驗收條件**
- [ ] 正規化支援兩種 `resets_at` 格式（ISO 含微秒、epoch 秒）與兩種百分比單位（0–1、0–100）；`resets_at < now` 的視窗視為 0%
- [ ] 分段取所有啟用視窗中最嚴重者。warn 注入一行用量資訊；wind-down 注入 FR-2 規定的四點收尾指示
- [ ] 同一個 session 在同一分段只注入一次，分段升級後才再注入；輸入帶 `agent_id` 時不注入

**驗證**
- [ ] `node --test test/tiers.test.mjs test/guard-inject.test.mjs`（用假 stdin 餵 guard.mjs）
- [ ] 手動（檢查點 1）：在 VS Code 設 fake 80%，Claude 能複述注入內容

**相依**：2
**檔案**：`scripts/tiers.mjs`、`scripts/usage.mjs`（只有 fake 與正規化）、`scripts/guard.mjs`、兩個測試檔
**規模**：M

### 任務 4：usage 端點輪詢
**說明**：依 FR-1 來源 A 實作惰性輪詢。

**驗收條件**
- [ ] 只有在「快取年齡 ≥ poll_interval」「不在退避期」「搶到 poll.lock」三者都成立時才發請求；搶不到鎖就直接用現有快取
- [ ] 每次重讀 `.credentials.json`。token 已過期就不發請求；**任何情況都不刷新 token**
- [ ] 錯誤分類與退避：
  - 429：依 `retry-after` 退避，沒有該 header 時 300 秒
  - 401／403：標記憑證無效，退避 `poll_interval_seconds`
  - 逾時 3 秒或網路錯誤：沿用快取
  - 欄位缺失：只記錄欄位名稱，不記錄內容

**驗證**
- [ ] `node --test test/usage-poll.test.mjs`：本機假 HTTP server 模擬 200、429（附 `retry-after`）、401、逾時、欄位缺失
- [ ] 手動：真實端點一次 200，快取寫入正確；連續觸發 10 次 hook，實際請求只有 1 次

**相依**：3
**檔案**：`scripts/usage.mjs`、`test/usage-poll.test.mjs`、`test/helpers/fake-server.mjs`
**規模**：M

### 任務 5：來源合併、新鮮度、不可用原因與 UserPromptSubmit 注入
**驗收條件**
- [ ] 合併規則：以 `observed_at` 較新者為準；同一個 `resets_at` 週期內只接受相等或上升的值
- [ ] 資料超過 `stale_after_seconds` 或沒有資料時不阻擋，並注入「用量資料不可用：<原因>」，每個 session 只注入一次。原因要能區分 FR-3 列出的七種
- [ ] `prompt.mjs` 套用與 PreToolUse 相同的注入邏輯，並共用「已注入」紀錄

**驗證**
- [ ] `node --test test/merge.test.mjs test/prompt.test.mjs`

**相依**：4
**檔案**：`scripts/usage.mjs`、`scripts/prompt.mjs`、測試檔
**規模**：S–M

### 任務 6：slash command 的 status、on／off、set
**驗收條件**
- [ ] `status` 顯示：
  - 各視窗的百分比、重置倒數、目前分段
  - 資料來源與年齡
  - 退避狀態與不可用原因
  - snooze 與已停止狀態
  - 使用 fake 時標示 FAKE
- [ ] `on`／`off` 切換 `enabled`；`off` 時所有 hook 直接放行
- [ ] `set` 依 §5 驗證，不合法時拒絕並說明原因；`prompt_timeout_seconds` 上限為 110

**驗證**
- [ ] `node --test test/cli.test.mjs`
- [ ] 手動（檢查點 2）：在 VS Code 執行 `/usage-sentinel status`

**相依**：5
**檔案**：`scripts/cli.mjs`、`commands/usage-sentinel.md`、`test/cli.test.mjs`
**規模**：S

### 任務 7：dialog.mjs（Windows）與 test-dialog
**說明**：Node → PowerShell `-EncodedCommand` → WinForms 三按鈕對話框，文字用環境變數傳遞，忽略 stderr。

**驗收條件**
- [ ] 視窗設為 TopMost，中文顯示正常，預設按鈕為「停止」；只有 5 小時視窗才顯示「到重置前不再問」
- [ ] 逾時由 hook 自己計時：時間到就 kill 對話框程序，回傳 `timeout`；PowerShell 不存在或啟動失敗時回傳 `unavailable`
- [ ] `/usage-sentinel test-dialog` 用假資料跳出對話框，回報選擇與耗時

**驗證**
- [ ] `node --test test/dialog.test.mjs`：只測 PowerShell 指令組裝與 unavailable 路徑
- [ ] 手動：`test-dialog` 三個按鈕與逾時各測一次（§7 實機測試）

**相依**：6
**檔案**：`scripts/dialog.mjs`、`scripts/cli.mjs`、`test/dialog.test.mjs`
**規模**：S

### 任務 8：觸發停止、決策鎖、繼續或停止、snooze
**驗收條件**
- [ ] 觸發條件：任一視窗 ≥ stop 門檻且沒有有效 snooze，或任一視窗 ≥ 99%（這條優先於任何 snooze）
- [ ] `prompt.lock` 保證全機只有一個對話框。沒搶到鎖的呼叫輪詢 `decision.json`，最多等 `prompt_timeout_seconds + 10` 秒，等不到就視為停止
- [ ] 選「繼續」：snooze 設為「按下時的百分比 + step」，或（5 小時視窗）設為 `resets_at`，然後**不輸出任何決策**。選「停止」或逾時：寫入 `stopped.json`。每次詢問都寫入 `events.log`

**驗證**
- [ ] `node --test test/stop-flow.test.mjs`：以假對話框（環境變數注入的 stub）模擬平行 N 個 guard，確認只跳一次、全部套用同一個選擇
- [ ] 手動：驗收 1、2、5、6

**相依**：7
**檔案**：`scripts/guard.mjs`、`scripts/state.mjs`、`scripts/tiers.mjs`、測試檔
**規模**：M

### 任務 9：已停止狀態與收尾模式
**驗收條件**
- [ ] 允許清單（FR-4.7）：
  - Bash／PowerShell 指令必須以 `git add` 或 `git commit` 開頭，且不含任何複合字元
  - Write／Edit 的目標只能是 `resume_file` 或 `plan_files` 裡的檔案
- [ ] 不在清單內的呼叫：第一次輸出 `deny` 並附收尾指示；第 `stop_grace_denials` 次，或收尾已完成時，輸出 `deny` + `continue:false` + `stopReason`
- [ ] 已停止狀態持續到觸發視窗的 `resets_at`，或執行 `/usage-sentinel resume` 為止；`snooze <分鐘|clear>` 可用。subagent 觸發的停止對主 agent 同樣生效

**驗證**
- [ ] `node --test test/allowlist.test.mjs test/winddown.test.mjs`：涵蓋 `git commit && rm x`、`git commit; ...`、反引號、`$(`、換行、PowerShell
- [ ] 手動：驗收 3、4、7

**相依**：8
**檔案**：`scripts/tiers.mjs`、`scripts/guard.mjs`、`scripts/post.mjs`、`scripts/cli.mjs`、測試檔
**規模**：M

### 任務 10：ask 備援、PostToolUse 核准偵測、無人值守
**驗收條件**
- [ ] 對話框回傳 `unavailable` 時，輸出 `ask` 與 `permissionDecisionReason`，並記下 `tool_use_id`
- [ ] 同一個 `tool_use_id` 之後觸發了 PostToolUse，就視為「繼續」並寫入 snooze
- [ ] `CLAUDE_CODE_SESSION_ATTENDED=0` 時直接停止、不詢問；取不到這個變數時視為有人值守

**驗證**
- [ ] `node --test test/ask-fallback.test.mjs`
- [ ] 手動：驗收 10（`claude -p` 搭配 fake 93%）

**相依**：9
**檔案**：`scripts/guard.mjs`、`scripts/post.mjs`、測試檔
**規模**：S

### 任務 11：自我保護（FR-4.8）
**驗收條件**
- [ ] 在任何分段（包括 normal）都擋下：
  - Write／Edit 寫入狀態資料夾或 `.credentials.json`
  - Bash／PowerShell 指令字串中出現這兩個路徑
- [ ] Bash／PowerShell 直接執行 `cli.mjs`、`install-statusline.mjs` 也要擋下。slash command 已設 `disable-model-invocation: true`，agent 只剩這條路能改設定
- [ ] 路徑比對要正規化：`~`、`$HOME`、`%USERPROFILE%`、正反斜線、大小寫（Windows）
- [ ] 執行 `uninstall.mjs` 或 `/usage-sentinel uninstall` 時輸出 `ask`，不輸出 `deny`

**驗證**
- [ ] `node --test test/self-protect.test.mjs`
- [ ] 手動：驗收 9、16

**相依**：9
**檔案**：`scripts/tiers.mjs`、`scripts/guard.mjs`、測試檔
**規模**：S

**檢查點 3** 在這裡。

### 任務 12：桌面通知與 webhook
**驗收條件**
- [ ] 進入 wind-down 與 stop 時，用 PowerShell toast 發一次通知，失敗就略過；`notify.desktop=false` 時不發
- [ ] 設定了 `webhook_url` 時 POST 一則訊息，只含百分比與專案資料夾名稱；逾時 3 秒，不阻擋 hook

**驗證**
- [ ] `node --test test/notify.test.mjs`：用假 server 驗證 webhook 內容不含完整路徑
- [ ] 手動：看到 toast

**相依**：8
**檔案**：`scripts/notify.mjs`、`scripts/guard.mjs`、測試檔
**規模**：S

### 任務 13：SessionStart 的 bin／manifest，以及 statusLine
**驗收條件**
- [ ] SessionStart 在 plugin 版本變更時，把 `uninstall.mjs`、`statusline.mjs` 複製到 `bin/`，並更新 `manifest.json`
- [ ] `statusline.mjs`：
  - 把 `rate_limits` 正規化後寫入快取
  - 輸出 `5h 62% (2h10m) · 7d 38%`，依分段變色
  - 用 shell 執行 `chain_statusline` 的原字串（例如 claude-hud），傳入同一份 stdin，把它的輸出接在後面
- [ ] `install-statusline.mjs`：先備份，只改 `statusLine` 一個鍵；原本的值存到 `chain_statusline`

**驗證**
- [ ] `node --test test/statusline.test.mjs test/install-statusline.test.mjs`（在隔離的 `CLAUDE_CONFIG_DIR` 中執行）
- [ ] 手動：在終端機 CLI 裡，claude-hud 與本工具同時顯示

**相依**：5
**檔案**：`scripts/session-start.mjs`、`scripts/statusline.mjs`、`scripts/install-statusline.mjs`、測試檔
**規模**：M

### 任務 14：uninstall.mjs 本機部分
**說明**：先完成不依賴 `claude` CLI 的步驟：1、2、3、4、8、9，以及 8.5 的本機檢查。

**驗收條件**
- [ ] 預設先列出清單，按 Enter 確認；支援 `--yes`、`--dry-run`、`--purge`
- [ ] statusLine 只有在仍指向本工具時才還原，使用者已改過就不動並提示；其他鍵不受影響
- [ ] 冪等：重複執行時每項顯示「已不存在」並 exit 0；plugin 資料夾已被刪除時仍能完成

**驗證**
- [ ] `node --test test/uninstall-local.test.mjs`（隔離的 `CLAUDE_CONFIG_DIR`）
- [ ] 手動：驗收 11、13、14、15、18

**相依**：13
**檔案**：`scripts/uninstall.mjs`、測試檔
**規模**：M

### 任務 15：uninstall.mjs 的 Claude Code 部分
**說明**：完成步驟 0、5、6、7、10，以及完整的自我檢查。

**驗收條件**
- [ ] 步驟 0：偵測到執行中的 `claude.exe` 時拒絕執行並列出程序，加 `--force` 才繼續
- [ ] 用 `claude plugin list --json` 找出所有範圍的安裝並逐一移除；失敗時改為直接刪除 `enabledPlugins` 項目，並印出手動修復步驟。之後處理市集宣告與 cache（只在沒有執行中 session 時刪除）
- [ ] 設定差異報告會列出所有非本工具造成的變動（例如 `model` 被正規化），並附上備份路徑；自我檢查有 ⚠️ 時 exit 1

**驗證**
- [ ] `node --test test/uninstall-roundtrip.test.mjs`：在隔離的 `CLAUDE_CONFIG_DIR` 中做完整的「安裝 → 使用 → 移除」往返，前後檔案清單比對（驗收 21）
- [ ] 手動：驗收 12、17、19、20

**相依**：14
**檔案**：`scripts/uninstall.mjs`、測試檔
**規模**：M（偏大，若超出一個 session 就把步驟 0 拆出去）

### 任務 16：README 與 macOS／Linux 對話框
**驗收條件**
- [ ] README 包含：
  - 安裝方式、設定說明、各平台需求
  - 已知限制：未公開端點、VS Code 不執行 statusLine、`-p` 無法用 slash command 移除
  - 只用 `claude plugin uninstall` 會留下什麼（FR-8.2-3）
- [ ] （次要）用 `osascript`／`zenity`／`kdialog` 實作相同介面；找不到就回傳 `unavailable`

**驗證**
- [ ] `node --test`（全部測試）
- [ ] 人工審閱 README

**相依**：15
**規模**：S

## 平行化機會
- 任務 7（對話框）只依賴 CLI 外殼，可以和任務 4–6 平行進行。
- 任務 12（通知）和任務 13（statusLine）在任務 8／5 完成後可以平行。
- 任務 14–15（uninstall）只依賴 manifest 格式。manifest 格式在任務 13 定案後，就能和第三階段的手動驗證平行。

## 風險與對策

| 風險 | 影響 | 對策 |
|---|---|---|
| usage 端點改版或失效 | 高 | 正規化時嚴格驗證欄位，不符就 fail-open 並在 status 顯示原因；端點相關邏輯集中在 usage.mjs |
| 429 鎖定 5 分鐘，可能連帶影響 Claude Code 的 `/usage` 面板 | 中 | 輪詢間隔 ≥ 60 秒、遵守 `retry-after`、全機一個輪詢者；測試時一律用 fake 或假 server |
| 「PostToolUse ⇒ ask 已核准」只觀察過一次（§9） | 中 | 任務 10 實機重測；不成立時改成「ask 下一次呼叫就視為繼續」或放棄這條路徑，回報給你決定 |
| 偵測 VS Code 內建的 `claude.exe` 不可靠（§9） | 中 | 任務 15 先做最保守的偵測（任何 `claude.exe` 都算）；`--force` 作為逃生口 |
| 平行 hook 與多 session 的競爭條件 | 高 | 所有共享狀態都經過 mkdir 鎖或原子寫入；任務 8 用多程序測試覆蓋 |
| 自我保護的路徑比對被繞過（變數、相對路徑、編碼） | 中 | 這只是盡力而為的防護，不是安全邊界，README 會寫明；測試涵蓋常見寫法 |
| hook 例外導致誤擋，卡住工作 | 高 | 全域 try/catch 並 fail-open；有 `DISABLED`／環境變數可停用；gate 先於所有 import |
| 實機驗收要你在 VS Code 手動操作 | 低 | 每個檢查點列出具體步驟，集中一次請你跑 |

## 待決問題（需要你決定）

1. **測試用端點覆寫**：是否接受新增 `USAGE_SENTINEL_ENDPOINT`，並限制只在設了 `USAGE_SENTINEL_DIR` 時生效？需求書沒有寫，但整合測試需要它。
2. **發佈方式與市集名稱**：本 repo 是否同時當作專屬市集（`.claude-plugin/marketplace.json`）？市集名稱要叫什麼？這會影響 FR-8.4 步驟 6、7 的路徑。
3. **macOS／Linux 對話框**：v1 要做，還是只留介面，找不到就回傳 `unavailable`（交給 ask 備援）？我建議 v1 只做 Windows。
4. **「收尾已完成」的判定**：計畫採用「在已停止狀態下，PostToolUse 看到 `git commit` 成功，**且**看到對 `resume_file` 的寫入」。要不要接受這個做法？還是只看第 `stop_grace_denials` 次 deny 就好？
