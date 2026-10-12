// 進入 wind-down 與 stop 時的通知（FR-5）。實際送出交給脫離的子程序，不拖慢 hook。
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimInjection } from './state.mjs';

const WINDOW_LABELS = { five_hour: '5 小時', seven_day: '7 天' };
const KIND_TEXT = { wind_down: '已進入收尾階段', stop: '已達停止門檻' };
const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'notify-worker.mjs');

// 只放百分比與專案資料夾名稱，不放完整路徑。
export function notificationText(kind, trigger, project) {
  return `usage-sentinel：${WINDOW_LABELS[trigger.window]}用量 ${Math.round(trigger.pct)}%，${KIND_TEXT[kind]}（${project}）`;
}

// Slack incoming webhook 要 JSON {text}；ntfy 等其他服務直接收純文字。
export function webhookRequest(url, text) {
  if (/^https:\/\/hooks\.slack\.com\//.test(url)) {
    return { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) };
  }
  return { headers: { 'content-type': 'text/plain; charset=utf-8' }, body: text };
}

function dispatch(notification, env) {
  // 測試用替身：只在設了 USAGE_SENTINEL_DIR 時生效，把通知寫進檔案。
  const stub = env.USAGE_SENTINEL_DIR && env.USAGE_SENTINEL_NOTIFY_STUB;
  if (stub) {
    try {
      appendFileSync(stub, JSON.stringify(notification) + '\n');
    } catch {
      // 替身寫不進去也不能改成真的送出
    }
    return;
  }
  const child = spawn(process.execPath, [WORKER], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      USAGE_SENTINEL_NOTIFY_TEXT: notification.text,
      USAGE_SENTINEL_NOTIFY_DESKTOP: notification.desktop ? '1' : '0',
      USAGE_SENTINEL_NOTIFY_WEBHOOK: notification.webhook_url ?? '',
    },
  });
  child.on('error', () => {});
  child.unref();
}

// 每個分段在每個重置週期全機只通知一次（不是每個 session 一次）。
export function maybeNotify(input, { dir, config, env }, { assessment, result }) {
  if (!assessment.available || !result) return;
  if (result.tier !== 'wind_down' && result.tier !== 'stop') return;
  const { desktop, webhook_url: webhookUrl } = config.notify;
  if (!desktop && !webhookUrl) return;
  const cycle = result.trigger.resets_at ? Math.round(result.trigger.resets_at / 60) : 'none';
  if (!claimInjection(dir, 'notify', `${result.tier}-${result.trigger.window}-${cycle}`)) return;
  const project = basename(input.cwd || process.cwd());
  dispatch(
    { kind: result.tier, text: notificationText(result.tier, result.trigger, project), desktop, webhook_url: webhookUrl },
    env,
  );
}
