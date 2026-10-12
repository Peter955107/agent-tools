// SessionStart hook 進入點。只靜態 import gate.mjs，其餘在通過檢查後才載入（FR-8.1）。
import { shouldRun } from './gate.mjs';

if (shouldRun({ allowMissingDir: true })) {
  const { runHook } = await import('./hook-runner.mjs');
  const { handleSessionStart } = await import('./handlers/session-start.mjs');
  await runHook('SessionStart', handleSessionStart);
}
