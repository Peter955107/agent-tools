# usage-sentinel

Claude Code 用量守衛：接近 5 小時或 7 天用量上限時，提醒 Claude 收尾、停下並詢問是否繼續。

## 安裝

```
claude plugin marketplace add <repo 路徑或網址>
claude plugin install usage-sentinel@usage-sentinel
```

安裝後開一個新的 Claude Code session，SessionStart 會建立狀態資料夾 `~/.claude/usage-sentinel/`（有設定 `CLAUDE_CONFIG_DIR` 時放在該目錄底下）。

需求：Node.js。停止時的對話框只支援 Windows，其他平台改用 Claude Code 的權限確認視窗。

## 分段

每個啟用的視窗（5 小時、7 天）各自計算，取最嚴重的分段。門檻是兩個視窗**共用**的。

| 分段 | 預設門檻 | 行為 |
|---|---|---|
| normal | < 75% | 不干預 |
| warn | ≥ 75% | 顯示一行用量資訊 |
| wind_down | ≥ 85% | 要 Claude 不開新的大步驟、commit、更新 `RESUME.md` 與 plan，並發桌面通知 |
| stop | ≥ 92% | 停下並詢問：繼續／到重置前不再問（只有 5 小時視窗）／停止 |

選擇「停止」後只允許 `git add`／`git commit`，以及編輯 `resume_file`、`plan_files`，其他工具呼叫都會被擋下。這個狀態會持續到視窗重置或執行 `resume` 為止。

## 指令

指令名稱帶 plugin 前綴：`/usage-sentinel:usage-sentinel <子指令>`。這些指令只能由使用者執行，Claude 不能代你下（見[自我保護](#已知限制)）。

| 子指令 | 作用 |
|---|---|
| `status`（預設） | 顯示各視窗用量、重置倒數、分段、資料來源、snooze 與停止狀態 |
| `on` / `off` | 開啟／關閉守衛 |
| `set <鍵> <值>` | 修改設定（見下方） |
| `snooze <1–1440 分鐘>` | 這段時間內達到停止門檻不再詢問（到 99% 仍會問） |
| `snooze clear` | 清除所有 snooze |
| `resume` | 解除「已停止」狀態 |
| `test-dialog` | 用假資料跳出一次停止對話框，不寫入任何狀態 |
| `install-statusline` | 安裝 statusLine（選配，只在終端機 CLI 有效） |
| `uninstall [--yes]` | 不加 `--yes` 只列出要移除的項目 |

## 設定

設定檔是 `~/.claude/usage-sentinel/config.json`。建議用 `set` 修改：它只寫入你改過的鍵，驗證失敗時不會動到設定檔。值會先當 JSON 解析，解析失敗就當字串。

```
/usage-sentinel:usage-sentinel set thresholds.wind_down 90
/usage-sentinel:usage-sentinel set notify.desktop false
/usage-sentinel:usage-sentinel set windows ["five_hour"]
/usage-sentinel:usage-sentinel set plan_files ["tasks/plan.md","tasks/todo.md"]
```

| 鍵 | 預設 | 說明與限制 |
|---|---|---|
| `enabled` | `true` | 等同 `on`／`off` |
| `windows` | `["five_hour","seven_day"]` | 要監看的視窗，非空且不重複 |
| `thresholds.warn` / `.wind_down` / `.stop` | `75` / `85` / `92` | 必須滿足 `0 < warn < wind_down < stop < 99` |
| `poll_interval_seconds` | `120` | 查詢用量的間隔，整數，`60 ≤ poll_interval_seconds ≤ stale_after_seconds` |
| `stale_after_seconds` | `600` | 資料超過這個秒數視為過期 |
| `prompt_timeout_seconds` | `90` | 對話框逾時（視為停止），10–110 的整數 |
| `snooze_step` | `4` | 按「繼續」後，用量再增加幾 % 才會再問，1–10 |
| `stop_grace_denials` | `3` | 停止後被擋第幾次就直接結束回合，≥ 1 的整數 |
| `resume_file` | `"RESUME.md"` | 收尾時要更新的檔案 |
| `plan_files` | `[]` | 停止後仍允許編輯的 plan 檔 |
| `notify.desktop` | `true` | wind_down／stop 時發桌面通知 |
| `notify.webhook_url` | `null` | 選填的 http(s) webhook，例如 ntfy、Slack |

**調整門檻的順序**：每次 `set` 都會檢查整組門檻，所以要調高時先改 `stop` 再改 `wind_down`，調低時反過來。例如目前 `stop` 是 92，直接把 `wind_down` 設成 93 會被拒絕：

```
/usage-sentinel:usage-sentinel set thresholds.stop 97
/usage-sentinel:usage-sentinel set thresholds.wind_down 93
```

直接手改 `config.json` 時，只要有任何一項不合法，就會**整份退回預設值**（守衛照常運作），`status` 會列出錯誤。

## 移除

主要方式是在 Claude Code **外**的終端機執行：

```
node ~/.claude/usage-sentinel/bin/uninstall.mjs
```

選項：
- `--dry-run`：只列清單，不動任何東西
- `--yes`：略過確認
- `--purge`：一併刪除備份資料夾
- `--force`：還有 Claude Code 在執行時仍繼續移除（plugin cache 會保留）
- `--skip-claude`：只清本機檔案，不呼叫 claude CLI

也可以在 Claude Code 裡執行 `/usage-sentinel:usage-sentinel uninstall --yes`。

只執行 `claude plugin uninstall usage-sentinel` 會留下：statusLine 設定、狀態資料夾、市集宣告、plugin cache。

## 已知限制

- 用量資料來自未公開的端點，格式可能隨時改變；資料不可用時守衛會提醒，但不會阻擋。
- VS Code 擴充套件不執行 statusLine。
- `-p`（無人值守）模式下達到停止門檻會直接停止；這個模式也無法用 slash command 移除。
- 自我保護（擋下 agent 修改 `~/.claude/usage-sentinel/` 與憑證檔）只是盡力而為的字串比對，不是安全邊界。
- 停止對話框只支援 Windows。

## 開發

```
node --test
USAGE_SENTINEL_E2E=1 node --test test/e2e-roundtrip.test.mjs
```
