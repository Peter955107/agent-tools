// hook 共用外殼：讀 stdin JSON、呼叫處理函式、輸出結果。
// 任何例外都 fail-open（exit 0、不輸出決策），並記錄到 errors.log（§6）。
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './gate.mjs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function logError(hook, error, env = process.env) {
  const dir = stateDir(env);
  // 資料夾不存在時不記錄：其他 hook 絕不能建立狀態資料夾（FR-7）。
  if (!existsSync(dir)) return;
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      hook,
      error: String(error?.stack || error),
    });
    appendFileSync(join(dir, 'errors.log'), line + '\n');
  } catch {
    // 連錯誤都寫不進去時只能放棄。
  }
}

// handler(input, { env, dir }) 回傳要輸出的物件，或 undefined 表示不輸出。
export async function runHook(name, handler, env = process.env) {
  try {
    let input = {};
    try {
      input = JSON.parse(await readStdin()) ?? {};
    } catch {
      input = {};
    }
    const output = await handler(input, { env, dir: stateDir(env) });
    if (output !== undefined) process.stdout.write(JSON.stringify(output));
  } catch (error) {
    logError(name, error, env);
  }
  process.exitCode = 0;
}
