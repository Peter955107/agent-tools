// PreToolUse 與 UserPromptSubmit 共用的注入判斷（FR-2、FR-3）。
import { claimInjection } from './state.mjs';
import { computeTier, injectionText, userMessage } from './tiers.mjs';
import { assessUsage, getUsage, readPollState } from './usage.mjs';

// 注入紀錄的鍵：分段 + 觸發視窗的重置週期，讓新週期裡同一分段可以再注入一次。
// 重置時間以分鐘取整，避免端點回傳的微秒差異被當成不同週期。
function injectionKey(result) {
  const cycle = result.trigger?.resets_at ? Math.round(result.trigger.resets_at / 60) : 'none';
  return `${result.tier}-${result.trigger?.window ?? 'none'}-${cycle}`;
}

// 回傳這次要注入的內容：context 給 Claude、message 顯示給使用者；不需要注入時回傳 undefined。
export async function pendingInjection(input, { dir, config, env, nowMs }) {
  // subagent 的呼叫不注入（FR-2），也不能佔用主 agent 的注入機會。
  if (input.agent_id) return undefined;
  const snapshot = await getUsage({ dir, config, env, nowMs });
  const assessment = assessUsage(snapshot, readPollState(dir), config, nowMs);
  // 資料不可用時不阻擋，只提醒一次（FR-3）。
  if (!assessment.available) {
    if (!claimInjection(dir, input.session_id, 'unavailable')) return undefined;
    const text = `usage-sentinel：用量資料不可用：${assessment.reason}`;
    return { context: text, message: text };
  }
  const result = computeTier(snapshot, config, nowMs);
  if (result.tier === 'normal') return undefined;
  if (!claimInjection(dir, input.session_id, injectionKey(result))) return undefined;
  return { context: injectionText(result, config, nowMs), message: userMessage(result, config, nowMs) };
}

export function injectionOutput(hookEventName, injection) {
  return {
    systemMessage: injection.message,
    hookSpecificOutput: { hookEventName, additionalContext: injection.context },
  };
}
