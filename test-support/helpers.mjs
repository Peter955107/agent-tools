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

// 測試用的隔離環境：空的 CLAUDE_CONFIG_DIR（沒有 credentials），端點指向連不上的本機位址，
// 確保測試絕不會讀到真正的 token、也不會打到真正的 usage 端點。
export function isolatedEnv(env) {
  if (!env.USAGE_SENTINEL_DIR) throw new Error('測試需要 USAGE_SENTINEL_DIR');
  return {
    ...cleanEnv(),
    CLAUDE_CONFIG_DIR: tempDir(),
    USAGE_SENTINEL_ENDPOINT: 'http://127.0.0.1:9/api/oauth/usage',
    USAGE_SENTINEL_DIALOG_STUB: 'stop', // 測試絕不跳出真的對話框
    USAGE_SENTINEL_NOTIFY_STUB: join(env.USAGE_SENTINEL_DIR, 'notify-stub.log'), // 也絕不發出真的通知
    USAGE_SENTINEL_UNINSTALL_PROCESSES: '[]', // 移除工具看不到真的 Claude Code 程序
    ...env,
  };
}

// 以子程序執行 hook 腳本，模擬 Claude Code 把 JSON 從 stdin 傳入。input 為字串時原樣送出。
export function runHook(script, { input = {}, env = {} } = {}) {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', script)], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: isolatedEnv(env),
    encoding: 'utf8',
    timeout: 20000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
