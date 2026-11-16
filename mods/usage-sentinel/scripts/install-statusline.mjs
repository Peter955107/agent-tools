// 選配：把 statusLine 指向 ~/.claude/usage-sentinel/bin/statusline.mjs（FR-7）。
// 先備份 settings.json，原本的 statusLine 存進 chain_statusline；寫入時只改 statusLine 一個鍵。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claudeDir, stateDir } from './gate.mjs';
import { readJson, writeJson } from './state.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

function readSettings(path) {
  if (!existsSync(path)) return { raw: null, value: {} };
  const raw = readFileSync(path, 'utf8');
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? { raw, value } : { raw, value: null };
  } catch {
    return { raw, value: null };
  }
}

const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export function installStatusline({ env = process.env } = {}) {
  const claude = claudeDir(env);
  const dir = stateDir(env);
  const settingsPath = join(claude, 'settings.json');
  const binPath = join(dir, 'bin', 'statusline.mjs');
  const command = `node "${binPath.replace(/\\/g, '/')}"`;

  const { raw, value: settings } = readSettings(settingsPath);
  if (!settings) return { code: 1, text: `${settingsPath} 不是合法 JSON，沒有做任何修改。` };
  if (settings.statusLine?.command === command) return { code: 0, text: 'statusLine 已經安裝，不需要再修改。' };

  mkdirSync(join(dir, 'bin'), { recursive: true });
  copyFileSync(join(SCRIPTS_DIR, 'statusline.mjs'), binPath);

  const backup = join(claude, 'backups', 'usage-sentinel', timestamp());
  mkdirSync(backup, { recursive: true });
  if (raw !== null) writeFileSync(join(backup, 'settings.json'), raw);

  const original = settings.statusLine ?? null;
  const configPath = join(dir, 'config.json');
  writeJson(configPath, { ...(readJson(configPath, {}) ?? {}), chain_statusline: original });

  // 寫入前重新讀一次，只改 statusLine，不把記憶體裡的舊內容整份寫回。
  const fresh = readSettings(settingsPath).value ?? settings;
  const statusLine = { type: 'command', command, ...(original?.padding !== undefined && { padding: original.padding }) };
  if (!writeJson(settingsPath, { ...fresh, statusLine })) return { code: 1, text: `寫入 ${settingsPath} 失敗，請稍後再試。` };

  const manifestPath = join(dir, 'manifest.json');
  writeJson(manifestPath, {
    ...(readJson(manifestPath, {}) ?? {}),
    statusline: { installed: true, command, original, backup, installed_at: new Date().toISOString() },
  });
  return {
    code: 0,
    text: `已設定 statusLine：${command}\n原本的 statusLine 會接在後面顯示。settings.json 備份在 ${backup}`,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { code, text } = installStatusline();
  process.stdout.write(text + '\n');
  process.exitCode = code;
}
