// /usage-sentinel slash command 的後端（FR-6）。只由使用者執行；agent 的呼叫由 FR-4.8 擋下。
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildStopDialog, showDialog } from './dialog.mjs';
import { stateDir } from './gate.mjs';
import { DEFAULT_CONFIG, loadConfig, mergeConfig, readJson, validateConfig, writeJson } from './state.mjs';
import { computeTier, formatDuration } from './tiers.mjs';
import { assessUsage, describePollFailure, getUsage, readPollState } from './usage.mjs';

const USAGE = [
  '用法：/usage-sentinel <子指令>',
  '  status                 顯示用量、分段、資料來源與狀態（預設）',
  '  on | off               開關守衛',
  '  set <key> <value>      修改設定，例如 set thresholds.stop 95',
  '  test-dialog            用假資料跳出一次停止對話框，回報選擇與耗時',
].join('\n');

const WINDOW_LABELS = { five_hour: '5 小時', seven_day: '7 天' };

// 可由 set 修改的鍵。chain_statusline 由 install-statusline.mjs 管理，不開放。
const SETTABLE = new Set([
  ...Object.keys(DEFAULT_CONFIG).filter((k) => !['thresholds', 'notify', 'chain_statusline'].includes(k)),
  ...Object.keys(DEFAULT_CONFIG.thresholds).map((k) => `thresholds.${k}`),
  ...Object.keys(DEFAULT_CONFIG.notify).map((k) => `notify.${k}`),
]);

const ok = (text) => ({ code: 0, text });
const fail = (text) => ({ code: 1, text });

async function status(dir, env) {
  if (!existsSync(dir)) {
    return ok('usage-sentinel 尚未初始化：狀態資料夾不存在。請開新的 Claude Code session，或執行 /usage-sentinel on。');
  }
  const nowMs = Date.now();
  const { config, errors } = loadConfig(dir);
  const snapshot = await getUsage({ dir, config, env, nowMs });
  const poll = readPollState(dir);
  const assessment = assessUsage(snapshot, poll, config, nowMs);
  const fake = snapshot?.source === 'fake';
  const lines = [`usage-sentinel 狀態${fake ? '（FAKE：使用 fake-usage.json）' : ''}`];

  if (env.USAGE_SENTINEL_DISABLE === '1') lines.push('- 守衛：已停用（USAGE_SENTINEL_DISABLE=1）');
  else if (existsSync(join(dir, 'DISABLED'))) lines.push('- 守衛：已停用（DISABLED 檔案存在）');
  else lines.push(`- 守衛：${config.enabled ? '啟用' : '已關閉（/usage-sentinel on 可重新開啟）'}`);

  if (snapshot) {
    const result = computeTier(snapshot, config, nowMs);
    for (const win of result.windows) {
      const reset = win.resets_at ? `（${formatDuration(win.resets_at - nowMs / 1000)}後重置）` : '';
      const tier = assessment.available ? `分段 ${win.tier}` : '資料不可用，不據此判斷';
      lines.push(`- ${WINDOW_LABELS[win.window]}：${Math.round(win.pct)}%${reset} · ${tier}`);
    }
    lines.push(`- 資料來源：${snapshot.source}，${Math.floor((nowMs / 1000 - snapshot.observed_at) / 60)} 分鐘前`);
  }
  const pollFailure = describePollFailure(poll, nowMs / 1000);
  if (!fake && pollFailure) lines.push(`- 輪詢：${pollFailure}`);
  if (!assessment.available) lines.push(`- 不可用原因：${assessment.reason}`);
  if (errors.length) lines.push(`- 設定錯誤（暫用預設值）：${errors.join('；')}`);
  return ok(lines.join('\n'));
}

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // 字串值不必加引號
  }
}

// 只寫入使用者改過的鍵，其餘沿用預設值；驗證失敗時不動設定檔。
function setConfig(dir, key, value) {
  if (!SETTABLE.has(key)) return fail(`未知的設定：${key}\n可設定的鍵：${[...SETTABLE].join(', ')}`);
  const path = join(dir, 'config.json');
  const partial = existsSync(path) ? readJson(path, undefined) : {};
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) return fail('config.json 不是合法 JSON，請先修正或刪除它。');

  const next = structuredClone(partial);
  const [head, leaf] = key.split('.');
  if (leaf) next[head] = { ...(next[head] ?? {}), [leaf]: value };
  else next[head] = value;

  const errors = validateConfig(mergeConfig(next));
  if (errors.length) return fail(`設定未變更：${errors.join('；')}`);
  mkdirSync(dir, { recursive: true });
  if (!writeJson(path, next)) return fail('寫入 config.json 失敗，請稍後再試。');
  return ok(`已設定 ${key} = ${JSON.stringify(value)}`);
}

const DIALOG_OUTCOMES = {
  continue: '選擇：繼續',
  until_reset: '選擇：到重置前不再問',
  stop: '選擇：停止',
  timeout: '逾時（視為停止）',
  dismissed: '關閉視窗（視為停止）',
  unavailable: '對話框不可用（實際觸發時會改用權限確認視窗）',
};

// 用假資料跳出一次對話框，只回報結果，不寫入任何決策或狀態。
async function testDialog(dir, dialog) {
  const nowMs = Date.now();
  const { config } = loadConfig(dir);
  const spec = buildStopDialog({
    trigger: { window: 'five_hour', pct: 93, resets_at: nowMs / 1000 + 72 * 60 },
    project: basename(process.cwd()),
    sessionId: 'test-dialog',
    nowMs,
    timeoutSeconds: config.prompt_timeout_seconds,
    fake: true,
  });
  const { choice, elapsedMs } = await dialog(spec);
  return ok(`test-dialog：${DIALOG_OUTCOMES[choice] ?? choice}，耗時 ${(elapsedMs / 1000).toFixed(1)} 秒`);
}

export async function runCli(args, { env = process.env, dialog = showDialog } = {}) {
  const dir = stateDir(env);
  const [command = 'status', ...rest] = args;
  switch (command) {
    case 'status':
      return status(dir, env);
    case 'on':
      return setConfig(dir, 'enabled', true);
    case 'off':
      return setConfig(dir, 'enabled', false);
    case 'set':
      if (rest.length !== 2) return fail(USAGE);
      return setConfig(dir, rest[0], parseValue(rest[1]));
    case 'test-dialog':
      return testDialog(dir, dialog);
    default:
      return fail(USAGE);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { code, text } = await runCli(process.argv.slice(2));
  process.stdout.write(text + '\n');
  process.exitCode = code;
}
