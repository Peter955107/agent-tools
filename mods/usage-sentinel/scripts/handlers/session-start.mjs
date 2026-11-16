import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeDir } from '../gate.mjs';
import { DEFAULT_CONFIG, readJson, writeJson } from '../state.mjs';

// 只有全新啟動或恢復 session 時才建立狀態資料夾。
// 舊 session 在移除後執行 /compact、/clear 也會觸發 SessionStart，那時不能把資料夾長回來（E9）。
const CREATING_SOURCES = new Set(['startup', 'resume']);
const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = join(SCRIPTS_DIR, '..');
// 複製到 bin/ 的檔案：plugin 損壞、刪除或更新換路徑後，移除工具與 statusLine 仍可用（FR-7）。
const BIN_FILES = ['uninstall.mjs', 'statusline.mjs'];
const MARKER_MAX_AGE_MS = 8 * 86400_000;

function pluginVersion() {
  return readJson(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), {})?.version ?? null;
}

// ~/.claude/plugins/cache/<市集>/usage-sentinel/<版本> → 市集名稱；從本機資料夾執行時為 null。
export function marketplaceFromRoot(root) {
  const parts = root.split(/[\\/]/);
  const index = parts.lastIndexOf('cache');
  return index >= 1 && parts[index - 1] === 'plugins' && parts[index + 2] === 'usage-sentinel' ? parts[index + 1] : null;
}

function updateBin(dir, version, manifest) {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  for (const name of BIN_FILES) {
    const source = join(SCRIPTS_DIR, name);
    const target = join(binDir, name);
    if (!existsSync(source)) continue;
    if (manifest.plugin_version === version && existsSync(target)) continue;
    copyFileSync(source, target);
  }
}

// 逐項記錄本工具在電腦上留下的東西，移除時以這份清單對照（FR-7、FR-8）。
function updateManifest(dir, env, version, manifest) {
  writeJson(join(dir, 'manifest.json'), {
    ...manifest,
    tool: 'usage-sentinel',
    plugin_version: version,
    plugin_root: PLUGIN_ROOT,
    marketplace: marketplaceFromRoot(PLUGIN_ROOT) ?? manifest.marketplace ?? null,
    state_dir: dir,
    bin_dir: join(dir, 'bin'),
    backups_dir: join(claudeDir(env), 'backups', 'usage-sentinel'),
    statusline: manifest.statusline ?? { installed: false },
    updated_at: new Date().toISOString(),
  });
}

function pruneInjectionMarkers(dir) {
  const injected = join(dir, 'injected');
  if (!existsSync(injected)) return;
  const cutoff = Date.now() - MARKER_MAX_AGE_MS;
  for (const name of readdirSync(injected)) {
    try {
      if (statSync(join(injected, name)).mtimeMs < cutoff) rmSync(join(injected, name), { force: true });
    } catch {
      // 清不掉就留到下次
    }
  }
}

export function handleSessionStart(input, { dir, env }) {
  if (CREATING_SOURCES.has(input.source)) mkdirSync(dir, { recursive: true });
  if (!existsSync(dir)) return undefined;
  try {
    // 'wx'：檔案已存在就失敗，不覆寫使用者設定，也避免兩個 session 同時寫入。
    writeFileSync(join(dir, 'config.json'), JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const version = pluginVersion();
  const manifest = readJson(join(dir, 'manifest.json'), {}) ?? {};
  updateBin(dir, version, manifest);
  updateManifest(dir, env, version, manifest);
  pruneInjectionMarkers(dir);
  return undefined;
}
