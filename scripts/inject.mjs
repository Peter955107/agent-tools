// PreToolUse 與 UserPromptSubmit 共用的注入判斷（FR-2）。
import { claimInjection } from './state.mjs';
import { computeTier, injectionText } from './tiers.mjs';
import { getUsage } from './usage.mjs';

// 注入紀錄的鍵：分段 + 觸發視窗的重置週期，讓新週期裡同一分段可以再注入一次。
// 重置時間以分鐘取整，避免端點回傳的微秒差異被當成不同週期。
function injectionKey(result) {
  const cycle = result.trigger?.resets_at ? Math.round(result.trigger.resets_at / 60) : 'none';
  return `${result.tier}-${result.trigger?.window ?? 'none'}-${cycle}`;
}

// 回傳這次要注入的文字；不需要注入時回傳 undefined。
export async function pendingInjection(input, { dir, config, env, nowMs }) {
  // subagent 的呼叫不注入（FR-2），也不能佔用主 agent 的注入機會。
  if (input.agent_id) return undefined;
  const snapshot = await getUsage({ dir, config, env, nowMs });
  if (!snapshot) return undefined;
  const result = computeTier(snapshot, config, nowMs);
  if (result.tier === 'normal') return undefined;
  if (!claimInjection(dir, input.session_id, injectionKey(result))) return undefined;
  return injectionText(result, config, nowMs);
}
