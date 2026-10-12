// 自我保護（FR-4.8）：避免 agent 自己關掉守衛、延長 snooze 或動到憑證。
// 這是盡力而為的字串比對，不是安全邊界：把路徑拆進變數再組合就攔不到。
import { join, resolve } from 'node:path';
import { claudeDir, stateDir } from './gate.mjs';

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// 涵蓋 ~、$HOME、%USERPROFILE%、$env:USERPROFILE 等各種寫法的共同部分。
const GENERIC_MARKERS = ['.claude/usage-sentinel', '.claude/.credentials.json'];

const DENY_REASON = 'usage-sentinel：不允許修改 usage-sentinel 的狀態檔或 Claude Code 的憑證（自我保護）。如需調整，請使用者自行執行 /usage-sentinel:usage-sentinel。';
const CLI_REASON = 'usage-sentinel：agent 不能執行 usage-sentinel 的設定指令（自我保護）。如需調整，請使用者自行執行 /usage-sentinel:usage-sentinel。';
const UNINSTALL_REASON = 'usage-sentinel：這個指令會移除 usage-sentinel，需要由你確認。';

function normalize(path, platform) {
  const s = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return platform === 'win32' ? s.toLowerCase() : s;
}

// C:/Users/... 在 Git Bash 裡寫成 /c/Users/...
function gitBashForm(path) {
  const match = /^([a-z]):\//i.exec(path);
  return match ? `/${match[1].toLowerCase()}/${path.slice(3)}` : null;
}

function protectedPaths(env, platform) {
  const dirs = [stateDir(env)].map((p) => normalize(resolve(p), platform));
  const files = [join(claudeDir(env), '.credentials.json')].map((p) => normalize(resolve(p), platform));
  return { dirs, files };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 路徑後面不能接著名稱字元，避免把 usage-sentinel-notes 當成 usage-sentinel。
function mentions(text, path) {
  return new RegExp(`${escapeRegExp(path)}(?![\\w.-])`).test(text);
}

function commandTouchesProtected(command, { dirs, files }) {
  const needles = [...GENERIC_MARKERS, ...dirs, ...files];
  return [...needles, ...needles.map(gitBashForm).filter(Boolean)].some((n) => mentions(command, n));
}

function isInside(target, { dirs, files }) {
  return files.includes(target) || dirs.some((d) => target === d || target.startsWith(`${d}/`));
}

// 回傳 { decision: 'deny' | 'ask', reason }；不需要介入時回傳 null。
export function selfProtection(input, { env = process.env, platform = process.platform } = {}) {
  const paths = protectedPaths(env, platform);
  const toolInput = input.tool_input ?? {};

  if (FILE_TOOLS.has(input.tool_name)) {
    const filePath = toolInput.file_path ?? toolInput.notebook_path;
    if (typeof filePath !== 'string' || !filePath) return null;
    const target = normalize(resolve(input.cwd || process.cwd(), filePath), platform);
    return isInside(target, paths) ? { decision: 'deny', reason: DENY_REASON } : null;
  }

  if (!SHELL_TOOLS.has(input.tool_name) || typeof toolInput.command !== 'string') return null;
  const command = normalize(toolInput.command, platform);
  const ownTool = command.includes('usage-sentinel');
  // 移除不直接擋：交給人決定（FR-8.2），避免 agent 為了繞過守衛自行移除。
  if (ownTool && /uninstall\.mjs/.test(command)) return { decision: 'ask', reason: UNINSTALL_REASON };
  if (ownTool && /(?:^|[/\s"'])(?:cli|install-statusline)\.mjs/.test(command)) return { decision: 'deny', reason: CLI_REASON };
  return commandTouchesProtected(command, paths) ? { decision: 'deny', reason: DENY_REASON } : null;
}

export function selfProtectionOutput({ decision, reason }) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } };
}
