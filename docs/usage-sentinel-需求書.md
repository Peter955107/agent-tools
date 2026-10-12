# 需求書：usage-sentinel — Claude Code 用量守衛 Plugin

> 給 Claude Code 的實作需求。請先讀完整份文件，再提出實作計畫，經我確認後才開始寫程式。

## 1. 背景與目標

長時間或無人看管的 agent 任務（`/loop`、過夜任務、多 subagent）常在撞到 5 小時或每週用量上限時中途死掉，留下未 commit 的修改，也沒有接續筆記。

本 plugin 要做到：

1. 讓 agent **知道目前剩餘用量**（官方數字，不是 token 估算）。
2. 接近上限時讓 agent **先收尾**（commit、寫接續筆記）。
3. 到達門檻時 **停下**，並 **跳出詢問視窗** 讓我決定是否繼續。

### 非目標

- 不估算 API 帳號（按 token 計費）的花費。
- 不做額度重置後自動喚醒已死掉的 session（那是 unsnooze 類工具的範圍，可列為未來擴充）。
- 不修改 Claude Code 的權限模式。

## 2. 參考專案總結

| 專案 | 資料來源 | 觸發 hook | 到門檻時的行為 | 值得借鏡的設計 |
|---|---|---|---|---|
| heavyc-dev/heavy-usage | statusLine 的官方 `rate_limits`，寫入 `~/.claude/heavy-usage/usage-live.json` | UserPromptSubmit | 75% 警告（回覆附一行用量）；90% 指示 Claude 停新工作、commit、寫接續筆記、結束 loop | 分段（warn / wind-down）；串接使用者原本的 statusLine；安裝前備份 settings.json 與 CLAUDE.md；`/usage on/off` 開關 |
| denverbaumgartner/usage-guard | statusLine → `rate_limits.json` | PreToolUse | 用量 ≥ 門檻（預設 90%）輸出 `{"continue": false}` 停下 agent 並發通知 | 每次工具呼叫前檢查，subagent 也擋得到；可選監控 `five_hour` / `seven_day`；snooze；`chain_statusline` |
| ManvikPasula/usage-guard | statusLine；可選輪詢 `GET /api/oauth/usage`（用本地 OAuth token） | PreToolUse + Stop + UserPromptSubmit | 在 hook 內睡到 `resets_at` + 緩衝，每 20 秒檢查，重置後自動繼續；每週額度若超過 `maxWaitSeconds` 就不等，改叫 Claude 停下回報 | 「暫停而非終止」；hook timeout 設約 6 小時；區分 5h 與 7d 的處理方式 |
| wolffshots/clusage | Go TUI + statusLine / API header | PreToolUse | 先等短暫尖峰（約 45 秒），仍過高就 deny 並叫 agent 停下回報 | **重要警告**：hook 阻塞數分鐘會被 Claude Code 判定「session stopped responding」；hook 逾時會放行工具呼叫，等待時間必須小於 hook timeout |
| Star001-KR/claude-session-budget | 讀本地 `~/.claude/projects/**/*.jsonl` 自行估算並自動校準 | PreToolUse | sync 門檻記錄、pause 門檻阻擋或睡眠，逾時 exit 2 | 不依賴 statusLine 的備援資料來源（但只是估計值） |
| saaranshM/unsnooze | StopFailure hook + tmux pane 擷取 | StopFailure | 撞牆後等重置，再自動恢復同一個 session | 撞牆後的補救；安全地回答 Claude 的限額選單 |

### 共同的技術事實

- Claude Code（v2.1.80 起）只把用量資料傳給 **statusLine 腳本** 的 stdin JSON：
  ```json
  "rate_limits": {
    "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
    "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
  }
  ```
- Hooks 的輸入 **沒有** 用量資料，所以必須用「statusLine 寫檔 → hook 讀檔」的方式橋接。
- 只有 Pro/Max 訂閱有此欄位，且要在 session 第一次 API 回應之後才出現。
- 曾有版本此欄位消失（issue #40094、#45133），必須能優雅處理「沒有資料」。
- `resets_at` 曾見過 epoch 秒數與 ISO 字串兩種格式，兩者都要支援。

## 3. 架構

```
Claude Code ──stdin JSON──▶ statusline.mjs ──寫入──▶ ~/.claude/usage-sentinel/state.json
                                   │
                                   └──串接執行使用者原本的 statusLine，輸出合併

每次工具呼叫 ──▶ PreToolUse hook (guard.mjs) ──讀 state.json──▶ 判斷分段
每次使用者送出 ──▶ UserPromptSubmit hook (prompt.mjs) ──▶ 注入用量資訊

到停止門檻 ──▶ 取得鎖 ──▶ 跳出詢問視窗 ──▶ 依選擇 allow / deny+停止
```

建議技術：Node.js ≥ 18，不使用外部套件（跨平台、Claude Code 使用者多半已有 Node）。以 Claude Code plugin 形式發佈（含 `.claude-plugin/plugin.json`、`hooks/hooks.json`、slash command）。

## 4. 功能需求

### FR-1 資料擷取（statusLine）

- 讀 stdin JSON，把 `rate_limits` 連同 `updated_at`（目前時間）與 `session_id` 原子寫入 `state.json`（寫暫存檔再 rename）。
- 若使用者原本已有 statusLine，安裝時保存原指令到設定檔，執行時把同一份 stdin 傳給它，並把其輸出接在本工具的輸出後面。
- 本工具自己的狀態列顯示：`5h 62% (2h10m) · 7d 38%`，依分段變色。
- 若 stdin 沒有 `rate_limits`，不覆寫舊資料，只更新「最後檢查時間」。

### FR-2 分段判斷

對每個啟用的視窗（預設 `five_hour` 與 `seven_day`）各自計算，取最嚴重的分段：

| 分段 | 預設門檻 | 行為 |
|---|---|---|
| normal | < 75% | 不干預 |
| warn | ≥ 75% | UserPromptSubmit 注入一行用量資訊，請 Claude 在回覆末尾附上 `🔋 5h 78% · 2h30m 後重置` |
| wind-down | ≥ 85% | 注入指示：不要開始新的大型工作，先把手上的修改 commit，並更新 `RESUME.md`（做了什麼、下一步、未完成的地方） |
| stop | ≥ 92% | PreToolUse 停下 agent，跳出詢問視窗（見 FR-4） |

門檻皆可設定，且需驗證 `warn < wind-down < stop`。

### FR-3 資料新鮮度

- `state.json` 的 `updated_at` 超過 `stale_after_seconds`（預設 600）視為過期。
- 過期或沒有資料時：**不阻擋**，但在 UserPromptSubmit 注入一行「用量資料不可用」提示，並在 `/usage-sentinel status` 顯示原因（例如「API 帳號無 rate_limits」「尚未收到第一次回應」「資料已過期 15 分鐘」）。

### FR-4 停止後跳出詢問視窗（新增需求，重點）

到達 stop 門檻時：

1. **取得全域鎖**（`~/.claude/usage-sentinel/prompt.lock`）。多個 session 或 subagent 同時觸發時，只跳一個視窗；其他呼叫等待同一個結果，不重複詢問。
2. **跳出系統原生對話框**，內容包含：
   - 哪個視窗觸發、目前百分比、重置倒數（例：「5 小時用量 93%，1 小時 12 分後重置」）
   - 觸發的專案資料夾與 session 簡稱
   - 三個按鈕：
     - **繼續**：放行，並設定 snooze 到用量再上升 `snooze_step`（預設 +4%）才再問
     - **繼續到重置前都不要再問**：snooze 到該視窗的 `resets_at`（若是 7 天視窗，需二次確認）
     - **停止**（預設按鈕）
3. **各平台實作**：
   - macOS：`osascript -e 'display dialog ... buttons {...} default button "停止" giving up after N'`
   - Windows：PowerShell `System.Windows.Forms` 對話框（含逾時）
   - Linux：依序嘗試 `zenity`、`kdialog`；並同時用 `notify-send` 發通知
4. **逾時**：對話框在 `prompt_timeout_seconds`（預設 90）內沒人回應 → 視為「停止」。這是無人看管時的安全預設。此值必須小於 hook 的 timeout 設定，並在安裝時檢查（參考 clusage 的警告）。
5. **無 GUI 時的備援**（SSH、headless、`DISPLAY` 不存在、對話框指令失敗）：
   - 互動式 session：PreToolUse 輸出 `permissionDecision: "ask"` 搭配 `permissionDecisionReason`，讓 Claude Code 自己的確認提示出現。
   - `-p`／非互動模式：直接視為「停止」。
6. **依選擇回應**：
   - 繼續 → 輸出 `permissionDecision: "allow"`，寫入 snooze 狀態。
   - 停止 → 先以 `permissionDecision: "deny"` 並在理由中指示 Claude「只允許 git commit 與寫 RESUME.md，完成後結束」；收尾完成（或再次觸發）後輸出 `{"continue": false, "stopReason": "usage-sentinel：已達 92% 用量，由使用者選擇停止"}`。
   - 收尾期間允許的工具清單可設定（預設：`Bash` 中的 `git add`／`git commit`、`Write`／`Edit` 只限 `RESUME.md`）。
7. **紀錄**：每次詢問與結果寫入 `~/.claude/usage-sentinel/events.log`（時間、session、百分比、選擇、是否逾時）。

### FR-5 通知

- 進入 wind-down 與 stop 時發桌面通知（可設定關閉）。
- 可選：webhook URL（例如 ntfy、Slack incoming webhook），用來通知不在電腦前的我。

### FR-6 Slash commands

- `/usage-sentinel status`：各視窗百分比、重置倒數、目前分段、snooze 狀態、資料新鮮度。
- `/usage-sentinel on|off`：開關（hooks 保持註冊，關閉時直接放行）。
- `/usage-sentinel set <key> <value>`：修改設定並驗證。
- `/usage-sentinel snooze <分鐘|clear>`。
- `/usage-sentinel test-dialog`：用假資料跳出一次對話框，確認平台支援。

### FR-7 安裝與移除

- 安裝腳本修改 `~/.claude/settings.json` 前先備份到 `~/.claude/backups/usage-sentinel/<timestamp>/`。
- 註冊 PreToolUse（matcher 全部工具）與 UserPromptSubmit hooks，並設定 timeout = `prompt_timeout_seconds + 30`。
- 移除腳本還原 statusLine 原指令、移除 hooks、刪除狀態資料夾（詢問後才刪）。

## 5. 設定檔

`~/.claude/usage-sentinel/config.json`：

```json
{
  "enabled": true,
  "windows": ["five_hour", "seven_day"],
  "thresholds": { "warn": 75, "wind_down": 85, "stop": 92 },
  "stale_after_seconds": 600,
  "prompt_timeout_seconds": 90,
  "prompt_default": "stop",
  "snooze_step": 4,
  "wind_down_allowed_tools": ["git add", "git commit", "RESUME.md"],
  "resume_file": "RESUME.md",
  "notify": { "desktop": true, "webhook_url": null },
  "chain_statusline": null
}
```

## 6. 邊界情況

- 多個 Claude Code session 同時跑：狀態檔共用（用量是帳號層級），鎖與 snooze 也是全域。
- 使用者已選「繼續」後用量持續上升：到 `stop + snooze_step` 再詢問一次；到 99% 時不論 snooze 都再問。
- 7 天視窗觸發且重置在數天後：對話框文字要明確說明「繼續可能撞牆、需等 X 天」。
- `bypassPermissions` 模式下 `permissionDecision: "ask"` 的行為需實測，若不會出現提示則一律走系統對話框或視為停止。
- hook 本身出錯（例外、讀檔失敗）：**放行**並記錄錯誤，不能因守衛壞掉而卡住工作。
- 長時間阻塞風險：對話框等待期間 hook 是阻塞的，需實測 Claude Code 在 90 秒等待下是否會判定 session 無回應；若會，降低預設逾時。

## 7. 測試與驗收

- 單元測試：分段計算、門檻驗證、`resets_at` 兩種格式解析、過期判斷、snooze 邏輯、鎖。
- 用假的 stdin JSON 餵 statusline 腳本與 hook 腳本做整合測試（不需要真的耗用額度）。
- 在目前作業系統上實測 `/usage-sentinel test-dialog`，三個按鈕與逾時各測一次。

驗收條件：

1. 用假資料設 93% → 下一次工具呼叫時跳出對話框。
2. 選「繼續」→ 工具正常執行，用量升到 97% 前不再詢問。
3. 選「停止」→ Claude 只做 commit 與更新 `RESUME.md`，然後結束，畫面顯示停止原因。
4. 不理會對話框 → 90 秒後自動停止。
5. 兩個 session 同時觸發 → 只出現一個對話框，兩邊都套用同一個選擇。
6. 刪掉 `rate_limits` → 不阻擋，`status` 顯示資料不可用的原因。
7. 移除後 `settings.json` 恢復成安裝前的內容。

## 8. 交付物

```
usage-sentinel/
├── .claude-plugin/plugin.json
├── hooks/hooks.json
├── commands/usage-sentinel.md
├── scripts/
│   ├── statusline.mjs
│   ├── guard.mjs          # PreToolUse
│   ├── prompt.mjs         # UserPromptSubmit
│   ├── dialog.mjs         # 跨平台對話框
│   ├── state.mjs          # 讀寫狀態、鎖、snooze
│   ├── install.mjs
│   └── uninstall.mjs
├── test/
└── README.md              # 安裝、設定、各平台需求（zenity 等）、已知限制
```
