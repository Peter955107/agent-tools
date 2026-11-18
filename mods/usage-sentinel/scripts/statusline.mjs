// statusLine（FR-1 來源 B，選配，只有終端機 CLI 會執行）。
// 會被複製到 ~/.claude/usage-sentinel/bin/ 單獨執行，plugin 更新或刪除後仍要能用，
// 所以只依賴 Node 內建模組；正規化與合併規則與 scripts/usage.mjs 相同。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const env = process.env;
const claudeDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const dir = env.USAGE_SENTINEL_DIR || join(claudeDir, 'usage-sentinel');
const WINDOWS = ['five_hour', 'seven_day'];
const LABELS = { five_hour: '5h', seven_day: '7d' };
const DEFAULT_THRESHOLDS = { warn: 75, wind_down: 85, stop: 92 };
const COLORS = { warn: '\x1b[33m', wind_down: '\x1b[38;5;208m', stop: '\x1b[31m' };
const RESET_COLOR = '\x1b[0m';

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
};

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function writeAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  } catch {
    return;
  }
  for (let attempt = 0; attempt <= 5; attempt += 1) {
    try {
      renameSync(tmp, path);
      return;
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EBUSY') break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 + Math.floor(Math.random() * 31));
    }
  }
  try {
    unlinkSync(tmp);
  } catch {
    // 寫入失敗不視為錯誤（FR-1）
  }
}

// statusLine 的 rate_limits：used_percentage 為 0–100，resets_at 為 epoch 秒。
function parseRateLimits(rateLimits, observedAt) {
  const windows = {};
  for (const name of WINDOWS) {
    const raw = rateLimits?.[name];
    if (!raw || typeof raw.used_percentage !== 'number' || !Number.isFinite(raw.used_percentage)) continue;
    windows[name] = {
      window: name,
      pct: Math.min(100, Math.max(0, raw.used_percentage)),
      resets_at: typeof raw.resets_at === 'number' ? raw.resets_at : null,
      observed_at: observedAt,
      source: 'statusline',
    };
  }
  return windows;
}

function sameCycle(a, b) {
  if (a.resets_at === null || b.resets_at === null) return a.resets_at === b.resets_at;
  return Math.abs(a.resets_at - b.resets_at) < 60;
}

// 與 usage.mjs 的 RESET_DROP 相同：同一週期內大幅下降視為提前重置。
const RESET_DROP = 10;

function mergeWindow(existing, incoming) {
  if (!existing) return incoming;
  if (!sameCycle(existing, incoming)) return incoming.observed_at > existing.observed_at ? incoming : existing;
  const newer = incoming.observed_at >= existing.observed_at ? incoming : existing;
  const older = newer === incoming ? existing : incoming;
  if (older.pct - newer.pct >= RESET_DROP) return newer;
  return { ...newer, pct: Math.max(existing.pct, incoming.pct) };
}

function countdown(seconds) {
  const minutes = Math.max(0, Math.floor(seconds / 60));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`;
}

function render(windows, config, now) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(config.thresholds ?? {}) };
  const parts = [];
  for (const name of Array.isArray(config.windows) ? config.windows : WINDOWS) {
    const win = windows[name];
    if (!win) continue;
    const isReset = win.resets_at !== null && win.resets_at <= now;
    const pct = isReset ? 0 : win.pct;
    const tier = pct >= thresholds.stop ? 'stop' : pct >= thresholds.wind_down ? 'wind_down' : pct >= thresholds.warn ? 'warn' : null;
    const reset = name === 'five_hour' && !isReset && win.resets_at !== null ? ` (${countdown(win.resets_at - now)})` : '';
    const text = `${LABELS[name]} ${Math.round(pct)}%${reset}`;
    parts.push(tier ? `${COLORS[tier]}${text}${RESET_COLOR}` : text);
  }
  return parts.join(' · ');
}

// Windows 上 Claude Code 用 Git Bash 執行 statusLine 指令；找不到時交給系統預設 shell。
function chainShell() {
  if (process.platform !== 'win32') return { file: '/bin/sh', args: ['-c'] };
  const bash = [env.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\Program Files\\Git\\bin\\bash.exe'].find((p) => p && existsSync(p));
  return bash ? { file: bash, args: ['-c'] } : null;
}

// 用 shell 執行原本的 statusLine 指令字串，把同一份 stdin 傳給它（FR-1）。
function runChained(chain, stdin) {
  const command = typeof chain === 'string' ? chain : chain?.command;
  if (typeof command !== 'string' || !command.trim()) return '';
  const shell = chainShell();
  const options = { input: stdin, encoding: 'utf8', timeout: 5000, windowsHide: true };
  const result = shell ? spawnSync(shell.file, [...shell.args, command], options) : spawnSync(command, { ...options, shell: true });
  return result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trimEnd() : '';
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString('utf8');
let input = {};
try {
  input = JSON.parse(stdin) ?? {};
} catch {
  input = {};
}

const now = Date.now() / 1000;
const active = env.USAGE_SENTINEL_DISABLE !== '1' && isDirectory(dir) && !existsSync(join(dir, 'DISABLED'));
const config = isDirectory(dir) ? readJson(join(dir, 'config.json'), {}) ?? {} : {};
const lines = [];

if (active) {
  const cachePath = join(dir, 'cache.json');
  const cache = readJson(cachePath, {}) ?? {};
  const windows = { ...(cache.windows ?? {}) };
  for (const [name, win] of Object.entries(parseRateLimits(input.rate_limits, Math.floor(now)))) {
    windows[name] = mergeWindow(windows[name], win);
  }
  // 沒有 rate_limits 時不覆寫用量，只更新最後檢查時間。
  writeAtomic(cachePath, { ...cache, windows, statusline_checked_at: Math.floor(now) });
  lines.push(render(windows, config, now) || 'usage —');
}

const chained = runChained(config.chain_statusline, stdin);
if (chained) lines.push(chained);
process.stdout.write(lines.join('\n') + (lines.length ? '\n' : ''));
