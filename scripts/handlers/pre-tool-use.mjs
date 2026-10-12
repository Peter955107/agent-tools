import { pendingInjection } from '../inject.mjs';
import { loadConfig } from '../state.mjs';

export function handlePreToolUse(input, { dir }) {
  const { config } = loadConfig(dir);
  if (!config.enabled) return undefined;
  const text = pendingInjection(input, { dir, config, nowMs: Date.now() });
  if (text === undefined) return undefined;
  // 只注入文字，不輸出 permissionDecision：輸出 allow 會跳過使用者的權限確認（A8）。
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } };
}
