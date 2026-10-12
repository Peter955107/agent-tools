// 緊急停用開關（FR-8.1）。每個 hook 進入點唯一靜態 import 的模組：
// 只依賴 Node 內建模組、不讀檔內容、不解析 JSON，確保其他模組壞掉時仍能停用。
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function stateDir(env = process.env, home = homedir) {
  return env.USAGE_SENTINEL_DIR || join(home(), '.claude', 'usage-sentinel');
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// allowMissingDir 只給 SessionStart 與使用者執行的 slash command 使用（FR-7）。
export function shouldRun({ env = process.env, allowMissingDir = false } = {}) {
  if (env.USAGE_SENTINEL_DISABLE === '1') return false;
  const dir = stateDir(env);
  if (!isDirectory(dir)) return allowMissingDir;
  return !existsSync(join(dir, 'DISABLED'));
}
