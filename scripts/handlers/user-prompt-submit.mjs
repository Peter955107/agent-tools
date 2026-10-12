import { injectionOutput, pendingInjection } from '../inject.mjs';
import { loadConfig } from '../state.mjs';

// 本工具自己的 slash command：Claude 只會轉述指令輸出，這時注入的提醒等於白白用掉。
const OWN_COMMAND = /^\s*\/usage-sentinel(?::usage-sentinel)?(?:\s|$)/;

export async function handleUserPromptSubmit(input, { dir, env }) {
  if (typeof input.prompt === 'string' && OWN_COMMAND.test(input.prompt)) return undefined;
  const { config } = loadConfig(dir);
  if (!config.enabled) return undefined;
  const injection = await pendingInjection(input, { dir, config, env, nowMs: Date.now() });
  if (injection === undefined) return undefined;
  return injectionOutput('UserPromptSubmit', injection);
}
