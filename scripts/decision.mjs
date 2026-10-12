// 停止與詢問（FR-4）：snooze、已停止狀態、決策鎖、詢問並記錄。
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isAllowedDuringStop, isSuccessfulCommit, wroteResumeFile } from './allowlist.mjs';
import { buildStopDialog } from './dialog.mjs';
import { acquireLock, readJson, releaseLock, writeJson } from './state.mjs';
import { sameCycle } from './usage.mjs';

const FORCE_PCT = 99;

export function snoozeEntry(choice, trigger, config, now) {
  const untilReset = choice === 'until_reset';
  return {
    window: trigger.window,
    asked_pct: trigger.pct,
    limit_pct: untilReset ? null : trigger.pct + config.snooze_step,
    until_reset: untilReset,
    resets_at: trigger.resets_at,
    set_at: now,
  };
}

// 99% 一律再問（§6，優先順序最高），但只覆蓋在 99% 以下取得的 snooze，
// 否則在 99% 按了「繼續」之後每次工具呼叫都會再跳視窗。
export function isSnoozeValid(entry, win) {
  if (!entry || !sameCycle(entry, win)) return false;
  if (win.pct >= FORCE_PCT && entry.asked_pct < FORCE_PCT) return false;
  return entry.until_reset || win.pct < entry.limit_pct;
}

// /usage-sentinel snooze <分鐘> 設定的手動 snooze，套用到所有視窗；99% 規則仍優先。
function isManualSnoozeValid(manual, win, nowMs) {
  return Boolean(manual) && manual.until * 1000 > nowMs && win.pct < FORCE_PCT;
}

// 需要詢問的視窗；百分比高的先問。不需要詢問時回傳 null。
export function promptTarget(result, snoozes, nowMs = Date.now()) {
  const candidates = result.windows.filter((w) => w.tier === 'stop' || w.pct >= FORCE_PCT).sort((a, b) => b.pct - a.pct);
  return (
    candidates.find((w) => !isManualSnoozeValid(snoozes?.manual, w, nowMs) && !isSnoozeValid(snoozes?.[w.window], w)) ?? null
  );
}

// 已停止狀態持續到觸發視窗重置，或使用者執行 resume（FR-4.5）。
export function activeStop(dir, nowMs) {
  const stop = readJson(join(dir, 'stopped.json'), null);
  if (!stop) return null;
  if (stop.resets_at !== null && stop.resets_at !== undefined && stop.resets_at * 1000 <= nowMs) return null;
  return stop;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 沒搶到 prompt.lock 的呼叫：等別人的決策反映到狀態檔（snooze 或 stopped）。
// 鎖消失但沒有結果時回傳 retry，等太久就視為停止（FR-4.2）。
export async function waitForOutcome({ check, lockPath, maxWaitMs, intervalMs = 250 }) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const outcome = check();
    if (outcome) return outcome;
    // 決策寫完才釋放鎖，所以鎖消失後要再確認一次結果。
    if (!existsSync(lockPath)) return check() ?? { kind: 'retry' };
    if (Date.now() >= deadline) return { kind: 'stop', reason: 'wait_timeout' };
    await sleep(intervalMs);
  }
}

function appendEvent(dir, event) {
  try {
    appendFileSync(join(dir, 'events.log'), JSON.stringify(event) + '\n');
  } catch {
    // 紀錄失敗不影響決策
  }
}

function writeStop(dir, { target, reason, input, now }) {
  const stop = {
    window: target.window,
    pct: target.pct,
    resets_at: target.resets_at,
    reason,
    session: input.session_id ?? null,
    at: now,
    denials: 0,
  };
  writeJson(join(dir, 'stopped.json'), stop);
  return stop;
}

// 詢問一次並寫入結果。呼叫者必須持有 prompt.lock。
async function askAndRecord(ctx, target) {
  const { dir, config, env, input, snapshot, dialog } = ctx;
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  let method = 'dialog';
  let dialogResult = null;
  let elapsedMs = 0;

  // 取不到 CLAUDE_CODE_SESSION_ATTENDED 時視為有人值守（§9）。
  if (env.CLAUDE_CODE_SESSION_ATTENDED === '0') {
    method = 'unattended';
  } else {
    const spec = buildStopDialog({
      trigger: target,
      project: basename(input.cwd || process.cwd()),
      sessionId: input.session_id,
      nowMs,
      timeoutSeconds: config.prompt_timeout_seconds,
      fake: snapshot.source === 'fake',
    });
    const onSpawn = (pid) => {
      try {
        writeFileSync(join(dir, 'prompt.lock', 'dialog.pid'), String(pid)); // 移除時用來結束殘留的對話框
      } catch {
        // 寫不進去只影響移除時的清理
      }
    };
    ({ choice: dialogResult, elapsedMs } = await dialog(spec, { onSpawn }));
  }

  const choice = dialogResult === 'continue' || dialogResult === 'until_reset' ? dialogResult : 'stop';
  const reason = { dialog: dialogResult === 'stop' ? 'user' : dialogResult, unattended: 'unattended' }[method] ?? 'user';
  const done = Math.floor(Date.now() / 1000);

  let outcome;
  if (choice === 'stop') {
    outcome = { kind: 'stopped', stop: writeStop(dir, { target, reason, input, now: done }) };
  } else {
    const snoozes = readJson(join(dir, 'snooze.json'), {}) ?? {};
    snoozes[target.window] = snoozeEntry(choice, target, config, done);
    writeJson(join(dir, 'snooze.json'), snoozes);
    outcome = { kind: 'continue' };
  }
  writeJson(join(dir, 'decision.json'), { choice, window: target.window, pct: target.pct, method, at: done });
  appendEvent(dir, {
    at: new Date().toISOString(),
    session: input.session_id ?? null,
    window: target.window,
    pct: target.pct,
    method,
    dialog_result: dialogResult,
    choice,
    timed_out: dialogResult === 'timeout',
    elapsed_ms: elapsedMs,
    source: snapshot.source,
    data_age_seconds: now - snapshot.observed_at,
  });
  return outcome;
}

// 達到停止門檻時決定這次呼叫的結果：{ kind: 'continue' } 或 { kind: 'stopped', stop }。
// 不需要詢問時回傳 null。同一時間全機只會有一個對話框（FR-4.2）。
export async function resolveStop(ctx) {
  const { dir, config, input, result } = ctx;
  const lockPath = join(dir, 'prompt.lock');
  const currentOutcome = () => {
    const stop = activeStop(dir, Date.now());
    if (stop) return { kind: 'stopped', stop };
    const target = promptTarget(result, readJson(join(dir, 'snooze.json'), {}));
    return target ? null : { kind: 'continue' };
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = currentOutcome();
    if (before) return attempt === 0 && before.kind === 'continue' ? null : before;

    const token = acquireLock(dir, 'prompt.lock', { ttlSeconds: config.prompt_timeout_seconds + 60 });
    if (token) {
      try {
        // 搶到鎖後再確認一次：別人可能剛做完決定。
        const settled = currentOutcome();
        if (settled) return settled;
        return await askAndRecord(ctx, promptTarget(result, readJson(join(dir, 'snooze.json'), {})));
      } finally {
        releaseLock(dir, 'prompt.lock', token);
      }
    }

    const outcome = await waitForOutcome({
      check: currentOutcome,
      lockPath,
      maxWaitMs: (config.prompt_timeout_seconds + 10) * 1000,
    });
    if (outcome.kind === 'retry') continue;
    if (outcome.kind === 'stop') {
      const target = promptTarget(result, {});
      return { kind: 'stopped', stop: writeStop(dir, { target, reason: 'wait_timeout', input, now: Math.floor(Date.now() / 1000) }) };
    }
    return outcome;
  }
  // 反覆搶鎖失敗：保守起見視為停止。
  const target = promptTarget(result, {});
  return { kind: 'stopped', stop: writeStop(dir, { target, reason: 'wait_timeout', input, now: Math.floor(Date.now() / 1000) }) };
}

export const STOP_REASONS = {
  user: '使用者選擇停止',
  timeout: '詢問逾時，自動停止',
  dismissed: '使用者關閉詢問視窗，視為停止',
  unattended: '無人值守模式，自動停止',
  unavailable: '無法跳出詢問視窗，自動停止',
  wait_timeout: '等待決策逾時，自動停止',
};

function denyReason(stop, config) {
  const why = STOP_REASONS[stop.reason] ?? '已停止';
  return `usage-sentinel：用量 ${Math.round(stop.pct)}%，${why}。只允許 git add／git commit 與編輯 ${config.resume_file}，完成後結束回覆`;
}

function stopReason(stop) {
  const why = stop.reason === 'user' ? '由使用者選擇停止' : STOP_REASONS[stop.reason] ?? '已停止';
  return `usage-sentinel：已達 ${Math.round(stop.pct)}% 用量，${why}`;
}

// 收尾模式（FR-4.6）：允許清單內的呼叫不輸出決策；其他呼叫 deny，
// 擋到第 stop_grace_denials 次或收尾已完成時，再加上 continue:false 結束回合。
export function stopModeResponse(input, stop, { dir, config }) {
  if (isAllowedDuringStop(input, config)) return undefined;
  const denials = (stop.denials ?? 0) + 1;
  writeJson(join(dir, 'stopped.json'), { ...stop, denials });
  const finished = denials >= config.stop_grace_denials || (stop.committed && stop.resume_written);
  const output = {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyReason(stop, config) },
  };
  // 單獨的 continue:false 不會擋下當次呼叫，必須搭配 deny（A11'）。
  return finished ? { ...output, continue: false, stopReason: stopReason(stop) } : output;
}

// PostToolUse：記錄收尾進度（commit 成功、resume_file 已寫入）。
export function recordWindDownProgress(input, { dir, config }) {
  const stop = activeStop(dir, Date.now());
  if (!stop) return;
  const committed = stop.committed || isSuccessfulCommit(input);
  const resumeWritten = stop.resume_written || wroteResumeFile(input, config);
  if (committed === Boolean(stop.committed) && resumeWritten === Boolean(stop.resume_written)) return;
  writeJson(join(dir, 'stopped.json'), { ...stop, ...(committed && { committed }), ...(resumeWritten && { resume_written: resumeWritten }) });
}
