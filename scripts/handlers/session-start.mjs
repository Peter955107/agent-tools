import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../state.mjs';

// 只有全新啟動或恢復 session 時才建立狀態資料夾。
// 舊 session 在移除後執行 /compact、/clear 也會觸發 SessionStart，那時不能把資料夾長回來（E9）。
const CREATING_SOURCES = new Set(['startup', 'resume']);

export function handleSessionStart(input, { dir }) {
  if (CREATING_SOURCES.has(input.source)) mkdirSync(dir, { recursive: true });
  try {
    // 'wx'：檔案已存在就失敗，不覆寫使用者設定，也避免兩個 session 同時寫入。
    writeFileSync(join(dir, 'config.json'), JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error;
  }
  return undefined;
}
