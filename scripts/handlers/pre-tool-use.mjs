import { activeStop, denyReason, resolveStop } from '../decision.mjs';
import { dialogFor } from '../dialog.mjs';
import { injectionFor, injectionOutput, usageState } from '../inject.mjs';
import { loadConfig } from '../state.mjs';

function deny(stop, config) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denyReason(stop, config),
    },
  };
}

async function decide(input, { dir, env }, config) {
  const nowMs = Date.now();
  // 已停止狀態每次都要重新套用：視窗重新載入會自動接續被中斷的回合（A20）。
  const stop = activeStop(dir, nowMs);
  if (stop) return deny(stop, config);

  const ctx = { dir, config, env, nowMs };
  const state = await usageState(ctx);
  // 資料不可用時不阻擋（FR-3）；subagent 的呼叫也要套用停止（FR-2）。
  if (state.assessment.available) {
    const outcome = await resolveStop({ ...ctx, input, result: state.result, snapshot: state.snapshot, dialog: dialogFor(env) });
    if (outcome?.kind === 'stopped') return deny(outcome.stop, config);
  }

  const injection = injectionFor(input, ctx, state);
  // 「繼續」與一般狀態都不輸出 permissionDecision：輸出 allow 會跳過使用者的權限確認（A8）。
  return injection === undefined ? undefined : injectionOutput('PreToolUse', injection);
}

export async function handlePreToolUse(input, { dir, env }) {
  const { config } = loadConfig(dir);
  if (!config.enabled) return undefined;
  try {
    return await decide(input, { dir, env }, config);
  } catch (error) {
    // hook 出錯一律放行（§6），唯一例外是已確定的停止決策。
    const stop = activeStop(dir, Date.now());
    if (stop) return deny(stop, config);
    throw error;
  }
}
