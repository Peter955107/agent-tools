// 測試共用工具。放在 test/ 之外，避免被 `node --test` 當成測試檔執行。
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function tempDir() {
  return mkdtempSync(join(tmpdir(), 'usage-sentinel-test-'));
}

// 去掉會影響行為的環境變數，確保測試不受執行環境干擾。
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('USAGE_SENTINEL_') || key === 'CLAUDE_CODE_SESSION_ATTENDED') delete env[key];
  }
  return env;
}

// 以子程序執行 hook 腳本，模擬 Claude Code 把 JSON 從 stdin 傳入。
// env 必須帶 USAGE_SENTINEL_DIR，避免測試碰到真正的 ~/.claude。input 為字串時原樣送出。
export function runHook(script, { input = {}, env = {} } = {}) {
  if (!env.USAGE_SENTINEL_DIR) throw new Error('runHook 需要 USAGE_SENTINEL_DIR');
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', script)], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...cleanEnv(), ...env },
    encoding: 'utf8',
    timeout: 20000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
