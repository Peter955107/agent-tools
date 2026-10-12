import { recordAskApproval, recordWindDownProgress } from '../decision.mjs';
import { loadConfig } from '../state.mjs';

export function handlePostToolUse(input, { dir }) {
  const { config } = loadConfig(dir);
  if (!config.enabled) return undefined;
  recordAskApproval(input, { dir, config });
  recordWindDownProgress(input, { dir, config });
  return undefined;
}
