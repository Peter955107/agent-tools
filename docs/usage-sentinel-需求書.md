# 需求書 v2：usage-sentinel — Claude Code 用量守衛 Plugin

> 給 Claude Code 的實作需求。請先讀完整份文件與《假設驗證與需求衝突.md》，再提出實作計畫，經我確認後才開始寫程式。
> 文中 `A#`／`C#`／`E#`／`U#` 代號指向《假設驗證與需求衝突.md》裡的假設、衝突與實驗紀錄。

## 0. 與 v1 的差異

| 項目 | v1 | v2 | 依據 |
|---|---|---|---|
| 用量來源 | 只靠 statusLine | **主要：usage 端點（hook 內惰性輪詢）**；次要：statusLine（僅終端機 CLI 有） | A1、A2、E8 |
| warn／wind-down 注入點 | UserPromptSubmit | **PreToolUse `additionalContext`** + UserPromptSubmit | A5、A5'、C8 |
| 「繼續」的輸出 | `permissionDecision: "allow"` | **不輸出任何決策** | A8、C2 |
| 停止的輸出 | 收尾後 `continue:false` | **`deny` + `continue:false` 同時輸出** | A11'、C12 |
| 停止狀態 | 一次性 | **持續到重置或手動解除**（視窗重載會自動接續回合） | A20 |
| hooks 註冊 | 安裝腳本寫 settings.json + plugin hooks.json | **只用 plugin 的 hooks.json** | A19、C1 |
| 安裝腳本 | 必要 | **選配**，只處理 statusLine 顯示 | A18 |
| snooze 基準 | 不一致（96%／97%） | **按下時的百分比 + step** | C4 |
| 7 天視窗二次確認 | 第二個對話框 | **7 天視窗不提供「到重置前不再問」** | C6 |
| 收尾允許清單 | 只有 Bash | Bash + **PowerShell**，拒絕複合指令 | 盲點 |
| `-p` 模式 | 實際上無資料 | 端點資料可用，偵測到無人值守即停止 | A1、A17、C7 |
| 移除 | 整份還原 settings.json | 只還原本工具改過的欄位；**新增一鍵移除（FR-8）**，可在 Claude Code 外執行，涵蓋 `claude plugin uninstall` 不會清的 cache 與市集宣告，移除後自我檢查無殘留 | C9、E9 |
| 狀態資料夾 | 任何 hook 都可能建立 | 只有 SessionStart 與 slash command 能建立；資料夾不存在時其他 hook 什麼都不做 | E9 |

## 1. 背景與目標

使用情境：在 **Windows + VS Code 擴充套件**上，以 **Pro 方案**執行「有明確 plan 文件的長任務」。一個 prompt 會跑很久，中間很少有人互動，常在撞到 5 小時或每週用量上限時中途死掉，留下沒 commit 的修改，也沒有接續筆記。

本 plugin 要做到：

1. 讓 agent **知道目前剩餘用量**（官方數字，不是 token 估算）。
2. 接近上限時讓 agent **先收尾**：commit，並更新接續筆記或 plan 的進度。
3. 到達門檻時 **停下**，並 **跳出詢問視窗** 讓我決定是否繼續。

### 非目標

- 不估算 API 帳號（按 token 計費）的花費。
- 不做額度重置後自動喚醒已死掉的 session（可列為未來擴充）。
- 不修改 Claude Code 的權限模式，也不繞過它（因此不輸出 `allow`）。
- **不刷新 OAuth token**：只讀不寫，刷新會讓 token 輪替，可能使 Claude Code 被登出。
- **不使用 probe 推論請求取得用量**：會耗額度，且需冒用 Claude Code 的 system prompt，可能違反訂閱條款（E8）。

## 2. 已驗證的平台事實

以下皆已在本機實測（Claude Code CLI 2.1.293、VS Code 擴充套件 2.1.296）：

**用量來源**
- **VS Code 擴充套件面板不執行 statusLine**（A2），`-p` 模式也不執行（A1）。只有終端機 CLI 會執行。
- usage 端點 `GET https://api.anthropic.com/api/oauth/usage`：
  - header：`Authorization: Bearer <accessToken>`、`anthropic-beta: oauth-2025-04-20`
  - 回傳 `five_hour`／`seven_day` 的 `utilization`（0–100）與 `resets_at`（ISO 字串，含微秒）
  - **短時間內第 5 次起回 429，`retry-after: 300`**（E8）
- token 位置：`~/.claude/.credentials.json` → `claudeAiOauth.accessToken`，旁邊有 `expiresAt`（毫秒），由 Claude Code 自行刷新。
- statusLine 的 `rate_limits`：`used_percentage`（0–100）、`resets_at`（epoch 秒）。`resets_at` 一過，Claude Code 就會移除該視窗。

**hooks 行為**
- hook 輸入裡**沒有用量資料**（A4）。
- PreToolUse 可以用 `hookSpecificOutput.additionalContext` 注入文字，Claude 收得到（A5'）。
- 同一則訊息裡平行的工具呼叫，PreToolUse 會**平行**觸發（A7）。
- subagent 的工具呼叫也會觸發 PreToolUse，輸入帶 `agent_id`、`agent_type`（A6）。
- **不輸出決策 → 走一般權限流程；輸出 `allow` → 跳過權限確認**（A8）。
- `ask`：VS Code 互動模式下會跳出確認、等使用者核准；`-p` 下視同拒絕（A9、A9'）。
- `deny` 的理由會以 `PreToolUse:<Tool> hook error: <理由>` 的形式傳給 Claude（A10）。
- `continue:false` **不會擋下當次工具呼叫**；搭配 `deny` 才會擋下並停止。在 subagent 裡輸出時，只停該 subagent（A11、A11'）。
- hook 逾時或非 0／2 的 exit code → **工具照常執行**（A12）。`onFailure:"block"` 需要 2.1.295 以上，CLI 2.1.293 沒有。
- hook 阻塞 90 秒後 session 能正常繼續，VS Code 畫面也沒有出現任何「無回應」警告（A13）。
- `continue:false` 停下後，VS Code 視窗重新載入時會**自動接續被中斷的回合**（A20）。
- 環境變數 `CLAUDE_CODE_SESSION_ATTENDED`：`-p` 為 `0`，VS Code 互動為 `1`。未列在官方文件，可能改版（A17）。
- plugin 不能提供 statusLine（A18）；plugin 的 hooks 與 settings.json 的 hooks 會各自執行、不會去重（A19）。

**Windows**
- Node → PowerShell `-EncodedCommand` → WinForms 對話框可行：自訂中文按鈕與內文正常顯示、TopMost、逾時都正常（A14）。
- 讀者開著檔案時，`rename` 常回 EPERM（A15）。
- `mkdir` 當作跨程序鎖是可靠的（A16）。
- Node 冷啟動約 50ms。

## 3. 架構

```
            ┌───────────── 每次 PreToolUse / UserPromptSubmit ─────────────┐
            │                                                              │
            ▼                                                              │
   usage.mjs: 讀 cache.json ──夠新？──是──▶ 判斷分段 ──▶ 回應（見 FR-2、FR-4）
            │                                                              
            否（且不在 429 退避期、搶得到 poll.lock）                         
            ▼                                                              
   讀 .credentials.json → GET /api/oauth/usage（逾時 3s）→ 原子寫入 cache.json
                                                                          
   （選配）statusline.mjs ──只在終端機 CLI──▶ 也寫入 cache.json，再串接原本的 statusLine
```

- **沒有常駐程式**：輪詢由 hook 惰性觸發。長任務期間工具呼叫頻繁，資料自然會持續更新；沒有工具呼叫時也就不需要資料。
- 全部狀態放在 `~/.claude/usage-sentinel/`（不放 `${CLAUDE_PLUGIN_ROOT}`，因為 plugin 更新後那個路徑會變）。
- 技術：Node.js ≥ 18，不使用外部套件。以 Claude Code plugin 形式發佈（`.claude-plugin/plugin.json`、`hooks/hooks.json`、slash command）。

## 4. 功能需求

### FR-1 用量擷取

**來源 A：usage 端點（主要）**
- 只在以下條件**全部**成立時才發請求：
  1. 快取的年齡 ≥ `poll_interval_seconds`（預設 120，最小 60）
  2. 不在 429 退避期間
  3. 成功取得 `poll.lock`
- 搶不到鎖的呼叫**不等待**，直接用現有快取。
- 每次都重新讀 `.credentials.json`。`expiresAt` 已過期就不發請求，標記原因「token 已過期，等 Claude Code 刷新」。
- 收到 429：依 `retry-after` 設定退避（沒有該 header 時預設 300 秒），期間沿用快取。
- 401／403：標記「憑證無效」，退避 `poll_interval_seconds`。
- 網路錯誤或逾時（3 秒）：沿用快取並記錄。
- 回應格式不符預期（欄位缺失或型別不對）：當作沒有資料，並記錄原始回應的欄位名稱，不記錄內容。

**來源 B：statusLine（選配，只有終端機 CLI 有）**
- 讀 stdin 的 `rate_limits`，正規化後寫入同一個快取。
- 沒有 `rate_limits` 時不覆寫，只更新「最後檢查時間」。
- 若使用者原本已有 statusLine（例如 claude-hud），用 shell 執行原本的指令字串，把同一份 stdin 傳給它，並把它的輸出接在本工具輸出的後面。
- 本工具自己的顯示：`5h 62% (2h10m) · 7d 38%`，依分段變色。

**正規化與合併**
- 統一成 `{ window, pct: 0–100, resets_at: epoch 秒, observed_at, source }`。
- 兩個來源**以 `observed_at` 較新者為準**。
- 同一個 `resets_at` 週期內，百分比只接受相等或上升的值（避免舊資料蓋掉新資料）。
- 判斷時，`resets_at < now` 的視窗視為 0%（C11）。
- **同一週期的判定**：兩筆資料的 `resets_at` 相差 < 60 秒就視為同一週期。端點每次回傳的小數秒都不同（例如 `.833`、`.380`），不能用相等比較（E10）。

**寫檔**
- 寫暫存檔再 rename。遇到 EPERM／EBUSY 時，重試 5 次、間隔 20–50ms 隨機。仍然失敗就放棄這次寫入，不視為錯誤。

### FR-2 分段判斷與注入

對每個啟用的視窗（預設 `five_hour` 與 `seven_day`）各自計算，取最嚴重的分段：

| 分段 | 預設門檻 | 行為 |
|---|---|---|
| normal | < 75% | 不干預、不輸出 |
| warn | ≥ 75% | 注入一行用量資訊 |
| wind-down | ≥ 85% | 注入收尾指示（見下） |
| stop | ≥ 92% | 停下並詢問（FR-4） |

- **注入點**：PreToolUse 的 `additionalContext`，**以及** UserPromptSubmit。
- **同時顯示給使用者**：`additionalContext` 只有 Claude 看得到，所以每次注入都同時輸出 `systemMessage`，在畫面上顯示一行：
  - warn：`⚠ usage-sentinel：5 小時用量 80%（2 小時 10 分後重置）`
  - wind-down：`⚠ usage-sentinel：<用量>，已進入收尾階段，Claude 會 commit 並更新 <resume_file>`
  - 資料不可用：與注入給 Claude 的文字相同，`usage-sentinel：用量資料不可用：<原因>`
- **每個 session 在每個分段只注入一次**，直到分段升級為止。用 `session_id` 記錄已注入過的分段，避免每次工具呼叫都重複注入、浪費 context。
  - 紀錄的鍵是「分段 + 觸發視窗 + 該視窗的重置週期」。視窗重置進入新週期後，同一分段可以再注入一次。
  - 資料不可用的提醒另用一個鍵，每個 session 只提醒一次。
- **wind-down 指示的內容**：
  - 不要開始新的大型步驟。
  - 把手上的修改 commit。
  - 更新 `resume_file`：做了什麼、下一步、未完成的地方。
  - 若有 plan 文件，在 plan 上標記目前進度。
- 門檻皆可設定，必須滿足 `warn < wind_down < stop < 99`。
- 只在主 agent 的呼叫上注入；subagent 的呼叫（輸入有 `agent_id`）跳過注入，但仍要套用 FR-4 的阻擋。
- **本工具自己的 slash command 不注入**：UserPromptSubmit 遇到 `/usage-sentinel …`（含 plugin 命名空間 `/usage-sentinel:usage-sentinel …`）時直接略過，也不記為「已注入」。這時 Claude 只會轉述指令輸出，注入的提醒會被吃掉，同一分段之後就不會再提醒（E10）。

### FR-3 資料新鮮度與不可用

- 快取的 `observed_at` 超過 `stale_after_seconds`（預設 600）就視為過期。
- 過期或沒有資料時**不阻擋**。warn 等級的注入改成「用量資料不可用：<原因>」，每個 session 只注入一次。
- 原因要能區分：
  - 尚未取得
  - token 過期
  - 憑證無效
  - 429 退避中（剩 N 秒）
  - 網路錯誤
  - 回應格式改變
  - 資料已過期 N 分鐘

### FR-4 停止與詢問（重點）

**4.1 觸發**
- 任一啟用的視窗 ≥ `stop` 門檻，且沒有有效的 snooze（或任一視窗已 ≥ 99%）。

**4.2 決策鎖**
- 取得 `prompt.lock`（用 `mkdir` 建立；記錄 PID 與時間；超過 `prompt_timeout_seconds + 60` 秒的鎖視為死鎖，可以回收）。
- 同一 session 裡平行的呼叫、其他 session、subagent，都只會跳出一個視窗。
- 沒搶到鎖的呼叫輪詢 `decision.json`，最多等 `prompt_timeout_seconds + 10` 秒。等不到就視為「停止」。

**4.3 詢問方式**（依序嘗試）
1. **有人值守**（`CLAUDE_CODE_SESSION_ATTENDED` 不是 `0`）：
   - 跳出 Windows WinForms 對話框（TopMost，文字用 `-EncodedCommand` 加環境變數傳遞，忽略 stderr）。
   - 對話框內容：
     - 哪個視窗觸發、目前百分比、重置倒數（例如「5 小時用量 93%，1 小時 12 分後重置」）
     - 專案資料夾名稱、session 簡稱
     - 7 天視窗觸發時加註：「繼續可能撞牆，需等 X 天 Y 小時才會重置」
   - 按鈕：
     - **繼續**：snooze 到「按下時的百分比 + `snooze_step`」（預設 +4%）
     - **到重置前不再問**：snooze 到該視窗的 `resets_at`。**只有 5 小時視窗提供這個按鈕。**
     - **停止**：預設按鈕
   - macOS（`osascript`）與 Linux（`zenity`／`kdialog`）列為次要支援，介面相同。
2. **對話框不可用**（指令不存在、啟動失敗、非 Windows 且沒有 GUI）：輸出 `permissionDecision: "ask"`，並附上 `permissionDecisionReason`。
   - 若之後同一個 `tool_use_id` 觸發了 PostToolUse，代表使用者已核准 → 視為「繼續」並寫入 snooze。
3. **無人值守**（`CLAUDE_CODE_SESSION_ATTENDED=0`，例如 `-p`）：直接視為「停止」，不詢問。

**4.4 逾時**
- 對話框在 `prompt_timeout_seconds`（預設 90）內沒人回應 → 視為「停止」。
- 這個計時由 hook 自己負責，**必須小於 hooks.json 的 timeout**（固定 150 秒）。`set` 指令要驗證 `prompt_timeout_seconds ≤ 110`。

**4.5 依選擇回應**
- **繼續**：
  - 寫入 snooze 與 `decision.json`。
  - **不輸出任何決策**，讓一般權限流程照常運作。
- **停止**：
  - 寫入「已停止」狀態：持續到觸發視窗的 `resets_at`，或執行 `/usage-sentinel resume` 為止。
  - 進入收尾模式。

**4.6 收尾模式**（已停止狀態下的每一次工具呼叫）
- 呼叫符合 `stop_allowed_actions` → 不輸出決策，放行。
- 其他呼叫：
  - **第一次被擋**時：輸出 `deny`，理由為「usage-sentinel：用量 93%，使用者選擇停止。只允許 git add／git commit 與編輯 `<resume_file>`，完成後結束回覆」。
  - **第 `stop_grace_denials` 次被擋時**（預設 3），或收尾已完成時（已有 commit，且 `resume_file` 已寫入）：同時輸出 `deny` 與 `{"continue": false, "stopReason": "usage-sentinel：已達 93% 用量，由使用者選擇停止"}`。
- 因為視窗重新載入會接續回合，已停止狀態必須持續生效，每次工具呼叫都要重新套用。

**4.7 允許清單判定**（`stop_allowed_actions`）
- `Bash` 或 `PowerShell` 工具：
  - 指令去除前後空白後，必須以 `git add` 或 `git commit` 開頭。
  - **不得包含** `;`、`&&`、`||`、`|`、`` ` ``、`$(`、`>`、`<`、換行。
- `Write`、`Edit`：目標路徑的檔名等於 `resume_file`，或位於 `plan_files` 清單中。
- 其他工具一律不允許。

**4.8 自我保護**
- 任何階段都要擋下對以下路徑的寫入：
  - `~/.claude/usage-sentinel/` 底下的檔案
  - `~/.claude/.credentials.json`
- 擋下的範圍包括 Write、Edit，以及 Bash／PowerShell 指令字串中出現上述路徑的情況。
- 這是為了避免 agent 自己關掉守衛或延長 snooze。
- 唯一例外是執行 `uninstall.mjs`：不直接擋下，而是輸出 `ask` 交給人決定（FR-8.2）。

**4.9 紀錄**
- 每次詢問與結果寫入 `events.log`（JSON lines）：時間、session、視窗、百分比、詢問方式、選擇、是否逾時、資料來源與資料年齡。

### FR-5 通知

- 進入 wind-down 與 stop 時發桌面通知（可關閉）。
- Windows 用 PowerShell toast；失敗時略過。
- 可選：webhook URL（例如 ntfy、Slack incoming webhook）。內容只放百分比與專案資料夾名稱，不放路徑全名。

### FR-6 Slash commands

- `/usage-sentinel status`：顯示以下內容
  - 各視窗的百分比、重置倒數、目前分段
  - 資料來源與年齡
  - 退避狀態與不可用原因
  - snooze 與「已停止」狀態
- `/usage-sentinel on|off`：開關。hooks 保持註冊，關閉時直接放行。
- `/usage-sentinel set <key> <value>`：修改設定，並依 §5 驗證。
- `/usage-sentinel snooze <分鐘|clear>`。
- `/usage-sentinel resume`：解除「已停止」狀態。
- `/usage-sentinel test-dialog`：用假資料跳出一次對話框，回報選擇與耗時。
- `/usage-sentinel uninstall`：一鍵移除（見 FR-8）。

- 實際指令名稱帶 plugin 命名空間：`/usage-sentinel:usage-sentinel <子指令>`。
- 這些指令只能由使用者執行：command 設定 `disable-model-invocation: true`，agent 無法透過 SlashCommand 工具叫用。agent 只剩用 Bash／PowerShell 直接執行 `cli.mjs` 這條路，由 FR-4.8 擋下。
- 狀態資料夾不存在時，`status` 只回報「尚未初始化」，不建立資料夾；`on`／`off`／`set` 才會建立。
- `on`／`off`／`set` 只寫入改動的鍵；驗證失敗時不動設定檔。

### FR-7 安裝與移除

- **hooks**：只透過 plugin 的 `hooks/hooks.json` 註冊。
  - PreToolUse（matcher `*`，timeout 150）
  - PostToolUse（matcher `*`，timeout 10，用於 FR-4.3 的 ask 核准偵測）
  - UserPromptSubmit（timeout 10）
  - **SessionStart**（timeout 10）：見下方「狀態資料夾的建立」。
- **狀態資料夾的建立**（E9 結論 2）：
  - 只有 SessionStart hook 和使用者執行的 slash command 可以建立 `~/.claude/usage-sentinel/`。
  - SessionStart 只在 `source` 為 `startup` 或 `resume` 時建立；`clear`、`compact` 不建立。原因：移除後仍開著的舊 session 執行 `/clear`、`/compact` 也會觸發 SessionStart。
  - 預設 `config.json` 用「檔案不存在才寫入」的方式建立，不覆寫使用者設定，兩個 session 同時啟動也不會互相覆蓋。
  - 其他所有 hook 在資料夾不存在時都**什麼都不做**（exit 0），也**絕不建立**它。
  - 原因：plugin 移除後，舊 session 的 hooks 會繼續從殘留的 cache 路徑執行。如果 hook 會自動建立資料夾，剛移除完就會被長回來。
  - 安裝前就已經開著的 session，要重開或執行 `/reload-plugins` 才會啟用守衛。
- **SessionStart 每次都要做的事**：
  - 把 `uninstall.mjs` 與 `statusline.mjs` 複製到 `~/.claude/usage-sentinel/bin/`（plugin 版本變更時覆蓋）。這樣即使 plugin 已損壞或已被刪除，移除工具仍然存在；statusLine 也不會因為 plugin 更新、路徑改變而失效。這是借鏡 ManvikPasula 的 shim 做法。
  - 更新 `manifest.json`，逐項記錄本工具在電腦上留下的東西：狀態資料夾、備份位置、statusLine 是否由本工具設定、安裝範圍、市集名稱。移除時以這份清單對照（見 FR-8）。
- **statusLine**：選配，由 `install-statusline.mjs` 處理。
  - 修改前先備份 `~/.claude/settings.json` 到 `~/.claude/backups/usage-sentinel/<timestamp>/`。
  - 把原本的 `statusLine` 存到 `config.json` 的 `chain_statusline`。
  - settings.json 指向 `~/.claude/usage-sentinel/bin/statusline.mjs` 這個固定路徑。
  - 寫入方式：讀取目前檔案 → 只改 `statusLine` 一個鍵 → 寫回。不可整份覆寫成記憶體裡的舊內容。

### FR-8 一鍵移除

目標：一個指令移除所有 hooks 與相關檔案，**不留殘留**。即使 plugin 損壞、hook 正在誤擋、或 Claude Code 沒開，也要能用。

**8.1 緊急停用開關**（移除前、或移除失敗時的保險）
- 每個 hook 腳本的第一件事是檢查以下三項，任一成立就立刻 exit 0、不輸出：
  - `~/.claude/usage-sentinel/` 資料夾不存在（SessionStart 除外，見 FR-7）
  - `~/.claude/usage-sentinel/DISABLED` 檔案存在
  - 環境變數 `USAGE_SENTINEL_DISABLE=1`
- 這個檢查放在所有讀檔、解析與網路請求之前，確保守衛本身壞掉時也能停用。

**8.2 執行入口**（三種方式都做同一件事）
1. 在終端機（Claude Code 外）執行：`node ~/.claude/usage-sentinel/bin/uninstall.mjs`。這是主要方式，不受 hooks 影響。
2. 在 Claude Code 裡執行 `/usage-sentinel uninstall`。
   - 只有使用者能叫用（`disable-model-invocation`，見 FR-6）。
   - agent 若改用 Bash／PowerShell 直接執行 `uninstall.mjs`，guard **一律輸出 `ask`**，強制由人核准，避免 agent 為了繞過守衛而自行移除。
   - 在 `-p` 模式下 `ask` 會被拒絕，所以 `-p` 無法用這個方式移除。
3. 在 plugin 的 README 寫明：只執行 `claude plugin uninstall usage-sentinel` 會留下以下東西，應改用方式 1：
   - statusLine 設定
   - 狀態資料夾
   - 市集宣告
   - plugin cache（E9）

**8.3 預設流程**
- 先列出將移除的項目清單。
- 按一次 Enter 確認後執行。
- 加上 `--yes` 可以略過確認。
- 加上 `--dry-run` 只列清單、不動任何東西。

**8.4 移除項目與順序**

| 步驟 | 動作 | 細節與依據 |
|---|---|---|
| 0 | 預檢：執行中的 session | 列出執行中的 Claude Code 程序（終端機的 `claude.exe`、VS Code 擴充套件內建的 `claude.exe`）。有的話要求先全部關閉，加 `--force` 才繼續。原因：舊 session 會把啟動時的設定快照寫回磁碟，讓已移除的 plugin 或 statusLine 復活（#76570） |
| 1 | 建立停用開關 | 寫入 `DISABLED`。之後的步驟就算中途失敗，hooks 也已經失效 |
| 2 | 結束殘留程序 | 結束本工具仍在執行的對話框程序（依 `prompt.lock` 內記錄的 PID）；釋放 `poll.lock`、`prompt.lock` |
| 3 | 備份設定 | 把所有可能被改到的設定檔，連同 `plugins/installed_plugins.json`、`plugins/known_marketplaces.json`，備份到 `~/.claude/backups/usage-sentinel/<timestamp>-uninstall/` |
| 4 | 還原 statusLine | 只改 `statusLine` 一個鍵（先讀取、再合併、最後寫回），還原成 `chain_statusline`。若安裝後使用者已改過該欄位，就不動並提示 |
| 5 | 移除 plugin（每個範圍） | 用 `claude plugin list --json` 找出 `usage-sentinel@*` 的**所有**安裝（user／project／local，含 `projectPath`），逐一執行 `claude plugin uninstall <id> --scope <範圍> --json`。project 範圍可能卡死（#73697）；失敗時改為直接從該範圍的設定檔刪除 `enabledPlugins` 項目，並印出手動修復步驟 |
| 6 | 移除市集宣告 | 若本 plugin 來自專屬市集，而且該市集已沒有其他安裝中的 plugin，就執行 `claude plugin marketplace remove <市集>`。uninstall 不會移除市集宣告（E9） |
| 7 | 清除 plugin cache | 刪除 `~/.claude/plugins/cache/<市集>/usage-sentinel/`。uninstall 只會留下 `.orphaned_at` 標記，不會刪除（E9）。只在步驟 0 確認沒有執行中的 session 時才刪，否則保留給 Claude Code 自行回收，並在報告中註明 |
| 8 | 刪除狀態資料夾 | 刪除 `~/.claude/usage-sentinel/`，包含 config、快取、events.log、bin、manifest、`DISABLED` 本身 |
| 9 | 處理備份 | 詢問是否刪除 `~/.claude/backups/usage-sentinel/`（預設保留，`--purge` 一併刪除） |
| 10 | 比對設定差異 | 把移除前後的 settings.json 做「鍵層級」比對。**列出所有不是本工具造成的變動**，例如 Claude Code 寫入時把 `model: "opus"` 正規化成 `"opus[1m]"`（E9），或刪掉不認得的值（#84867），並附上備份路徑供還原 |

**8.5 殘留自我檢查**（移除後自動執行，結果印在最後）
- 掃描以下設定檔中是否還有 `usage-sentinel` 字樣：
  - `~/.claude/settings.json`、`~/.claude/settings.local.json`
  - 目前目錄的 `.claude/settings.json`、`.claude/settings.local.json`
- 檢查 `claude plugin list --json` 的所有範圍是否還列出本 plugin。**不能只相信 uninstall 回傳的成功訊息**（#83891）。
- 檢查 `plugins/known_marketplaces.json` 是否還有本工具的市集。
- 檢查以下資料夾是否還有本工具的東西：
  - `~/.claude/usage-sentinel/`
  - `~/.claude/plugins/data/`
  - `~/.claude/plugins/cache/`
- 檢查是否還有本工具的對話框程序在執行。
- 每項顯示以下三種結果之一：
  - ✅ 已清除
  - ⏳ 待 Claude Code 自行回收：只適用於 cache，且帶有 `.orphaned_at` 標記
  - ⚠️ 仍存在，附上手動清除方式
- 沒有任何 ⚠️ 時 exit 0，否則 exit 1。
- 最後固定提示：「若移除時有 session 開著（用了 `--force`），請重開它們或在其中執行 `/reload-plugins`，並在 5 分鐘後再執行一次 `--dry-run` 確認沒有復活」。

**8.6 冪等**
- 重複執行、或在部分移除失敗後再執行，都不能出錯。已經不存在的項目顯示「已不存在」並略過。

## 5. 設定檔

`~/.claude/usage-sentinel/config.json`：

```json
{
  "enabled": true,
  "windows": ["five_hour", "seven_day"],
  "thresholds": { "warn": 75, "wind_down": 85, "stop": 92 },
  "poll_interval_seconds": 120,
  "stale_after_seconds": 600,
  "prompt_timeout_seconds": 90,
  "snooze_step": 4,
  "stop_grace_denials": 3,
  "resume_file": "RESUME.md",
  "plan_files": [],
  "notify": { "desktop": true, "webhook_url": null },
  "chain_statusline": null
}
```

驗證規則：
- `warn < wind_down < stop < 99`
- `60 ≤ poll_interval_seconds ≤ stale_after_seconds`
- `10 ≤ prompt_timeout_seconds ≤ 110`
- `1 ≤ snooze_step ≤ 10`

## 6. 邊界情況

- **多個 session 同時跑**：快取、鎖、snooze、已停止狀態都是全域共用（用量是帳號層級）。
- **選了「繼續」後用量持續上升**：到「按下時的百分比 + `snooze_step`」再問。到 99% 時，不論 snooze 都再問；這條規則的優先順序最高。
- **重置後**：`resets_at < now` 的視窗視為 0%，snooze 與已停止狀態一併失效。
- **hook 自身出錯**（例外、讀檔失敗、解析失敗）：**放行**（exit 0，不輸出決策），並記錄錯誤。守衛壞掉時不能卡住工作。
  - 例外：已經確定的「停止」決策要照常執行。
- **usage 端點改版或失效**：視為資料不可用（FR-3），不阻擋，並在 status 顯示原因。
- **本工具的輪詢與 Claude Code 的 `/usage` 面板共用同一個頻率額度**：輪詢間隔不得低於 60 秒。

## 7. 測試與驗收

### 測試資料注入
- 環境變數 `USAGE_SENTINEL_DIR` 可覆寫狀態資料夾。
- 該資料夾內若有 `fake-usage.json`，優先使用它，不發網路請求，並在 status 與對話框標示「FAKE」。
  - 實機測試完記得刪掉：它的 `resets_at` 是手寫的固定日期，留著會讓注入一直顯示假的百分比與重置倒數。
- 環境變數 `USAGE_SENTINEL_ENDPOINT` 可覆寫 usage 端點 URL，**只在同時設了 `USAGE_SENTINEL_DIR` 時生效**，避免正式環境被導到別處而外洩 token。
- 環境變數 `CLAUDE_CONFIG_DIR` 會同時改變狀態資料夾（`<CLAUDE_CONFIG_DIR>/usage-sentinel/`）與 credentials 的位置。所有會執行 hook 的測試都要用隔離的 `CLAUDE_CONFIG_DIR`，並把端點指向不可連線的位址，避免打到真實端點、吃掉 429 額度。

### 單元測試
- 分段計算、門檻驗證
- 兩種 `resets_at` 格式與兩種百分比單位的正規化
- 來源合併（較新者為準、同週期只升不降、重置後歸零）
- 過期判斷、429 退避
- snooze（按下時的百分比 + step、99% 覆蓋）
- 允許清單（含複合指令、PowerShell）
- 自我保護路徑
- 鎖（死鎖回收）
- 每段只注入一次

### 整合測試
- 用假的 stdin JSON 餵 hook 腳本。
- 用本機假 HTTP server 模擬 usage 端點：200、429（附 `retry-after`）、401、逾時、欄位缺失。

### 實機測試（Windows + VS Code）
- `test-dialog`：三個按鈕與逾時各測一次。

### 驗收條件
1. `fake-usage.json` 設 93% → 下一次工具呼叫時跳出對話框。
2. 選「繼續」→ 工具正常執行，而且**原本需要權限確認的工具仍會跳出確認**；用量升到 97% 前不再詢問。
3. 選「停止」→ Claude 只做 commit 與更新 `resume_file`，然後結束；對話裡看得到停止原因。
4. 停止後重新載入 VS Code 視窗 → 接續的回合在第一次非允許的工具呼叫就被擋下。
5. 不理會對話框 → 90 秒後自動停止。
6. 同一則訊息裡的平行工具呼叫，以及兩個 session 同時觸發 → 只出現一個對話框，全部套用同一個選擇。
7. subagent 觸發 stop → 主 agent 的下一次工具呼叫也被擋下。
8. 刪掉 `fake-usage.json`，並讓假 server 回 429 → 不阻擋；status 顯示「429 退避中（剩 N 秒）」。
9. Agent 嘗試修改 `config.json` 或執行 `git commit && rm x` → 被擋下。
10. 執行 `-p` 且用量 ≥ 92% → 不跳視窗，直接停止。
11. 執行 `uninstall.mjs` 後，`statusLine` 欄位恢復成安裝前的值，其他欄位不受影響。
12. 在終端機執行一次 `node ~/.claude/usage-sentinel/bin/uninstall.mjs --yes`：殘留自我檢查全部 ✅；新開的 Claude Code session 裡工具呼叫不再觸發任何本工具的 hook。
13. 先手動刪掉 plugin 資料夾再執行移除 → 仍能完成，並清掉 statusLine 與狀態資料夾。
14. 連續執行兩次移除 → 第二次全部顯示「已不存在」，exit 0。
15. 建立 `DISABLED` 檔案 → 用量 93% 時也不擋、不注入。
16. agent 在 VS Code 裡用 Bash 執行 `uninstall.mjs` → 跳出權限確認，由人決定；agent 無法叫用 `/usage-sentinel uninstall`。
17. 移除時有其他 Claude Code session 開著 → 拒絕執行並列出那些程序；加 `--force` 才繼續。
18. 移除後，用 `--force` 時仍開著的舊 session 繼續呼叫工具 → 不擋、不注入，**也不會重建** `~/.claude/usage-sentinel/`。
19. plugin 同時裝在 user 與 project 範圍 → 兩個範圍都被移除。
20. 移除後的報告會列出所有不是本工具造成的設定變動（例如 `model` 被正規化），並附上備份路徑。
21. 完整的「安裝 → 使用 → 移除」往返測試在隔離的 `CLAUDE_CONFIG_DIR` 中執行，結束後與安裝前的檔案清單比對：除了 Claude Code 自己的檔案（`.claude.json`、`backups/`）之外沒有差異。

## 8. 交付物

```
usage-sentinel/
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json       # 本 repo 兼作專屬市集，市集名稱 usage-sentinel
├── hooks/hooks.json
├── commands/usage-sentinel.md
├── scripts/
│   ├── gate.mjs               # 停用開關與路徑（FR-8.1）；hook 進入點唯一靜態 import 的模組
│   ├── hook-runner.mjs        # hook 共用外殼：讀 stdin、fail-open、寫 errors.log
│   ├── handlers/              # 各 hook 的處理邏輯（由下列進入點動態載入）
│   ├── guard.mjs              # PreToolUse：注入、詢問、收尾模式、自我保護
│   ├── post.mjs               # PostToolUse：ask 核准偵測
│   ├── prompt.mjs             # UserPromptSubmit：注入
│   ├── session-start.mjs      # SessionStart：建立狀態資料夾、更新 bin/ 與 manifest
│   ├── inject.mjs             # PreToolUse 與 UserPromptSubmit 共用的注入判斷
│   ├── tiers.mjs              # 純邏輯：分段、注入文字
│   ├── usage.mjs              # 端點輪詢、退避、正規化、合併、快取
│   ├── dialog.mjs             # 跨平台對話框
│   ├── state.mjs              # 設定驗證、鎖、snooze、已停止狀態、原子寫入
│   ├── cli.mjs                # slash command 後端
│   ├── statusline.mjs         # 選配
│   ├── install-statusline.mjs # 選配
│   └── uninstall.mjs          # 一鍵移除（FR-8），會複製到 ~/.claude/usage-sentinel/bin/
├── test/                      # node --test
├── test-support/              # 假 HTTP server、測試共用函式
└── README.md                  # 安裝、設定、各平台需求、已知限制（未公開端點、VS Code 無 statusLine）
```

狀態資料夾 `~/.claude/usage-sentinel/` 內的檔案：

| 檔案 | 用途 |
|---|---|
| `config.json` | 設定（§5） |
| `cache.json` | 正規化後的各視窗用量 |
| `poll.json` | 上次輪詢時間、退避到期時間、不可用原因 |
| `injected/<session>.<key>` | 每個 session 已注入過的分段（空檔案，用建立成功與否判斷）；`<key>` 為 `<分段>-<視窗>-<重置週期>` 或 `unavailable` |
| `errors.log` | hook 例外紀錄（fail-open 時寫入） |
| `events.log` | 詢問與結果（FR-4.9） |
| `fake-usage.json` | 測試用假資料（§7） |
| `DISABLED` | 緊急停用開關（FR-8.1） |

## 9. 尚未驗證、實作時需留意

- `/api/oauth/usage` 的 429 確切視窗（目前只知道「約 1 分鐘內第 5 次」）。另外，被鎖時 Claude Code 自己的 `/usage` 面板是否也受影響，尚未驗證。
- 「同一 `tool_use_id` 觸發 PostToolUse ⇒ 使用者核准了 ask」：只在 U1 觀察到一次。
- 互動 session 在 plugin 移除後，執行 `/reload-plugins` 是否能確實卸下 hooks（只有文件說明，沒有實測）。
- 帶 `.orphaned_at` 標記的 cache，Claude Code 何時回收（文件沒寫）。
- 如何可靠偵測「VS Code 擴充套件內建的 claude.exe」正在執行，並與 Claude Code 自己啟動的子程序區分開來（FR-8.4 步驟 0）。
- `CLAUDE_CODE_SESSION_ATTENDED` 不是官方介面。取不到這個變數時，預設視為「有人值守」。
