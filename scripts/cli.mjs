// /usage-sentinel slash command 的後端（FR-6）。只由使用者執行；agent 的呼叫由 FR-4.8 擋下。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STOP_REASONS, activeStop } from './decision.mjs';
import { buildStopDialog, showDialog } from './dialog.mjs';
import { stateDir } from './gate.mjs';
import { installStatusline } from './install-statusline.mjs';
import { DEFAULT_CONFIG, loadConfig, mergeConfig, readJson, validateConfig, writeJson } from './state.mjs';
import { computeTier, formatDuration } from './tiers.mjs';
import { assessUsage, describePollFailure, getUsage, readPollState } from './usage.mjs';

const USAGE = [
  '用法：/usage-sentinel <子指令>',
  '  status                 顯示用量、分段、資料來源與狀態（預設）',
  '  on | off               開關守衛',
  '  set <key> <value>      修改設定，例如 set thresholds.stop 95',
  '  snooze <分鐘|clear>    暫時不詢問（到 99% 仍會問），或清除所有 snooze',
  '  resume                 解除「已停止」狀態',
  '  test-dialog            用假資料跳出一次停止對話框，回報選擇與耗時',
  '  install-statusline     （選配，只有終端機 CLI 有效）把 statusLine 指向本工具，原本的接在後面',
  '  uninstall [--yes]      一鍵移除；不加 --yes 只列清單（建議在 Claude Code 外的終端機執行）',
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
    let resetCount = 0;
    for (const win of result.windows) {
      const tier = assessment.available ? `分段 ${win.tier}` : '資料不可用，不據此判斷';
      const isReset = win.resets_at && win.resets_at * 1000 <= nowMs;
      if (isReset) {
        resetCount += 1;
        const raw = Math.round(snapshot.windows[win.window].pct);
        const when = new Date(win.resets_at * 1000).toLocaleString('zh-TW', { hour12: false });
        lines.push(`- ${WINDOW_LABELS[win.window]}：已重置（資料為 ${raw}%，但重置時間 ${when} 已過，視為 0%） · ${tier}`);
        continue;
      }
      const reset = win.resets_at ? `（${formatDuration(win.resets_at - nowMs / 1000)}後重置）` : '';
      lines.push(`- ${WINDOW_LABELS[win.window]}：${Math.round(win.pct)}%${reset} · ${tier}`);
    }
    if (fake && resetCount > 0 && resetCount === result.windows.length) {
      lines.push('- ⚠ fake-usage.json 的 resets_at 都已過去，所有視窗視為 0%，不會觸發任何提醒或停止。請改成未來的時間。');
    }
    lines.push(`- 資料來源：${snapshot.source}，${Math.floor((nowMs / 1000 - snapshot.observed_at) / 60)} 分鐘前`);
  }
  const pollFailure = describePollFailure(poll, nowMs / 1000);
  if (!fake && pollFailure) lines.push(`- 輪詢：${pollFailure}`);
  if (!assessment.available) lines.push(`- 不可用原因：${assessment.reason}`);
  lines.push(`- snooze：${describeSnooze(dir, nowMs)}`);
  lines.push(`- 已停止：${describeStop(dir, nowMs)}`);
  if (errors.length) lines.push(`- 設定錯誤（暫用預設值）：${errors.join('；')}`);
  return ok(lines.join('\n'));
}

const clock = (epochSeconds) => {
  const d = new Date(epochSeconds * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function describeSnooze(dir, nowMs) {
  const snoozes = readJson(join(dir, 'snooze.json'), {}) ?? {};
  const parts = [];
  if (snoozes.manual && snoozes.manual.until * 1000 > nowMs) parts.push(`手動，到 ${clock(snoozes.manual.until)}`);
  for (const [name, entry] of Object.entries(snoozes)) {
    if (name === 'manual' || !entry || (entry.resets_at && entry.resets_at * 1000 <= nowMs)) continue;
    parts.push(`${WINDOW_LABELS[name]} ${entry.until_reset ? '到重置' : `到 ${Math.round(entry.limit_pct)}%`}`);
  }
  return parts.length ? `${parts.join('；')}（99% 時仍會詢問）` : '無';
}

function describeStop(dir, nowMs) {
  const stop = activeStop(dir, nowMs);
  if (!stop) return '否';
  const why = STOP_REASONS[stop.reason] ?? '已停止';
  const progress = [stop.committed && '已 commit', stop.resume_written && `已更新 ${loadConfig(dir).config.resume_file}`].filter(Boolean);
  return [
    `是（${WINDOW_LABELS[stop.window]} ${Math.round(stop.pct)}%，${why}），已擋下 ${stop.denials ?? 0} 次`,
    progress.length ? `；收尾進度：${progress.join('、')}` : '',
    '；重置或執行 /usage-sentinel resume 後解除',
  ].join('');
}

function resume(dir) {
  if (!activeStop(dir, Date.now())) return ok('目前沒有停止，不需要解除。');
  rmSync(join(dir, 'stopped.json'), { force: true });
  return ok('已解除停止狀態。之後達到停止門檻時會再詢問。');
}

const MAX_SNOOZE_MINUTES = 1440;

function snooze(dir, arg) {
  const path = join(dir, 'snooze.json');
  if (arg === 'clear') {
    rmSync(path, { force: true });
    return ok('已清除所有 snooze。');
  }
  const minutes = Number(arg);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SNOOZE_MINUTES) {
    return fail(`用法：/usage-sentinel snooze <1–${MAX_SNOOZE_MINUTES} 分鐘|clear>`);
  }
  const until = Math.floor(Date.now() / 1000) + minutes * 60;
  const snoozes = readJson(path, {}) ?? {};
  mkdirSync(dir, { recursive: true });
  if (!writeJson(path, { ...snoozes, manual: { until } })) return fail('寫入 snooze.json 失敗，請稍後再試。');
  return ok(`${minutes} 分鐘內（到 ${clock(until)}）達到停止門檻不再詢問；到 99% 時仍會詢問。`);
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
  const { choice, elapsedMs, detail } = await dialog(spec);
  const why = choice === 'unavailable' && detail ? `，原因：${detail}` : '';
  return ok(`test-dialog：${DIALOG_OUTCOMES[choice] ?? choice}，耗時 ${(elapsedMs / 1000).toFixed(1)} 秒${why}`);
}

// 在 Claude Code 裡執行移除（FR-8.2 方式 2）。slash command 沒有鍵盤輸入，
// 所以沒指定 --yes 時只列清單；優先用 bin/ 的副本，plugin 本體壞掉時也能移除。
function uninstall(dir, env, flags) {
  const binCopy = join(dir, 'bin', 'uninstall.mjs');
  const script = existsSync(binCopy) ? binCopy : join(dirname(fileURLToPath(import.meta.url)), 'uninstall.mjs');
  const confirmed = flags.includes('--yes') || flags.includes('--dry-run');
  const result = spawnSync(process.execPath, [script, ...(confirmed ? flags : ['--dry-run', ...flags])], {
    env,
    encoding: 'utf8',
    timeout: 300000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd();
  const hint = confirmed ? '' : '\n\n確認清單後，執行 /usage-sentinel:usage-sentinel uninstall --yes 才會真的移除（建議改在 Claude Code 外的終端機執行，見 README）。';
  return { code: result.status ?? 1, text: output + hint };
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
    case 'resume':
      return resume(dir);
    case 'install-statusline':
      return installStatusline({ env });
    case 'uninstall':
      return uninstall(dir, env, rest);
    case 'snooze':
      return rest.length === 1 ? snooze(dir, rest[0]) : fail(USAGE);
    default:
      return fail(USAGE);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { code, text } = await runCli(process.argv.slice(2));
  process.stdout.write(text + '\n');
  process.exitCode = code;
}
