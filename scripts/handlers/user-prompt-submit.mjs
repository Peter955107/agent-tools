import { pendingInjection } from '../inject.mjs';
import { loadConfig } from '../state.mjs';

export async function handleUserPromptSubmit(input, { dir, env }) {
  const { config } = loadConfig(dir);
  if (!config.enabled) return undefined;
  const text = await pendingInjection(input, { dir, config, env, nowMs: Date.now() });
  if (text === undefined) return undefined;
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
}
