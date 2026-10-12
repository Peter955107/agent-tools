// 一鍵移除 usage-sentinel（FR-8）。
// 會被複製到 ~/.claude/usage-sentinel/bin/，plugin 損壞或已刪除、Claude Code 沒開時也要能執行，
// 所以只依賴 Node 內建模組，不 import 專案內其他檔案。
//
// 用法：node ~/.claude/usage-sentinel/bin/uninstall.mjs [--yes] [--dry-run] [--purge] [--force] [--skip-claude]
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = new Set(process.argv.slice(2));
const options = {
  yes: args.has('--yes'),
  dryRun: args.has('--dry-run'),
  purge: args.has('--purge'),
  force: args.has('--force'),
  skipClaude: args.has('--skip-claude'),
};

const env = process.env;
const claudeDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const stateDir = env.USAGE_SENTINEL_DIR || join(claudeDir, 'usage-sentinel');
const backupsRoot = join(claudeDir, 'backups', 'usage-sentinel');
const settingsPath = join(claudeDir, 'settings.json');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = join(backupsRoot, `${timestamp}-uninstall`);

// ---------- 小工具 ----------

const exists = (path) => existsSync(path);
const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
const readJson = (path, fallback = null) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
};
const normalizePath = (p) => p.replace(/\\/g, '/').toLowerCase();

function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, path);
      return;
    } catch (error) {
      if ((error.code !== 'EPERM' && error.code !== 'EBUSY') || attempt >= 5) {
        try {
          unlinkSync(tmp);
        } catch {
          // 忽略
        }
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 + Math.floor(Math.random() * 31));
    }
  }
}

// 測試用替身（假的 claude CLI、程序清單）只在設了 USAGE_SENTINEL_DIR 時生效。
const testMode = Boolean(env.USAGE_SENTINEL_DIR);

function runClaude(claudeArgs, { cwd } = {}) {
  const fake = testMode && env.USAGE_SENTINEL_CLAUDE_BIN;
  const result = fake
    ? spawnSync(process.execPath, [fake, ...claudeArgs], { cwd, env, encoding: 'utf8', timeout: 60000 })
    : spawnSync('claude', claudeArgs, { cwd, env, encoding: 'utf8', timeout: 120000, shell: process.platform === 'win32', windowsHide: true });
  return { ok: result.status === 0 && !result.error, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// claude plugin list --json；無法執行時回傳 null。
function listPlugins() {
  const result = runClaude(['plugin', 'list', '--json']);
  const list = result.ok ? parseJson(result.stdout) : null;
  return Array.isArray(list) ? list : null;
}

const isOurs = (plugin) => typeof plugin?.id === 'string' && plugin.id.startsWith('usage-sentinel@');
const marketOf = (id) => id.slice(id.indexOf('@') + 1);

function processTable() {
  if (testMode && env.USAGE_SENTINEL_UNINSTALL_PROCESSES) return parseJson(env.USAGE_SENTINEL_UNINSTALL_PROCESSES) ?? [];
  if (process.platform === 'win32') {
    const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress';
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    const rows = parseJson(result.stdout ?? '');
    return Array.isArray(rows) ? rows.map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name ?? '', path: r.ExecutablePath ?? '' })) : null;
  }
  const result = spawnSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) return null;
  return result.stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .map(([pid, ppid, ...rest]) => ({ pid: Number(pid), ppid: Number(ppid), name: rest.join(' ').split('/').pop(), path: rest.join(' ') }));
}

// 執行中的 Claude Code（終端機或 VS Code 內建的 claude.exe），排除自己的上層程序
// （從 Claude Code 裡執行移除時，當前 session 不算）。無法取得程序清單時回傳 null。
function runningSessions() {
  const table = processTable();
  if (!table) return null;
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const ancestors = new Set();
  for (let pid = process.ppid; pid && !ancestors.has(pid); pid = byPid.get(pid)?.ppid) ancestors.add(pid);
  return table.filter((p) => /^claude(\.exe)?$/i.test(p.name) && !ancestors.has(p.pid));
}

function scopeSettingsFile(plugin) {
  if (plugin.scope === 'user' || !plugin.projectPath) return settingsPath;
  return join(plugin.projectPath, '.claude', plugin.scope === 'local' ? 'settings.local.json' : 'settings.json');
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------- 讀取目前狀態 ----------

const manifest = readJson(join(stateDir, 'manifest.json'), null);
const config = readJson(join(stateDir, 'config.json'), null);
const dialogPidPath = join(stateDir, 'prompt.lock', 'dialog.pid');
// --skip-claude：只清本機檔案，不碰 Claude Code（不檢查執行中的 session、不呼叫 claude CLI）。
const sessions = options.skipClaude ? [] : runningSessions();
const pluginsBefore = options.skipClaude ? [] : listPlugins();
const ourInstalls = (pluginsBefore ?? []).filter(isOurs);
const knownMarketplacesPath = join(claudeDir, 'plugins', 'known_marketplaces.json');
// 本工具的專屬市集：安裝紀錄裡的市集，加上仍宣告著的 usage-sentinel 市集（plugin 已移除、市集殘留的情況）。
const ourMarkets = [
  ...new Set([...ourInstalls.map((p) => marketOf(p.id)), ...('usage-sentinel' in (readJson(knownMarketplacesPath, {}) ?? {}) ? ['usage-sentinel'] : [])]),
];
const cacheDirOf = (market) => join(claudeDir, 'plugins', 'cache', market, 'usage-sentinel');
const sessionsRunning = Boolean(sessions?.length);

function dialogPid() {
  const pid = Number.parseInt(readJson(dialogPidPath, null) ?? (exists(dialogPidPath) ? readFileSync(dialogPidPath, 'utf8') : ''), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// statusLine 是不是本工具設定的：優先比對 manifest 記錄的指令，否則看是否指向 bin/statusline.mjs。
function isOurStatusLine(statusLine) {
  const command = statusLine?.command;
  if (typeof command !== 'string') return false;
  if (manifest?.statusline?.command && command === manifest.statusline.command) return true;
  return normalizePath(command).includes(normalizePath(join(stateDir, 'bin', 'statusline.mjs'))) || /usage-sentinel\/bin\/statusline\.mjs/i.test(normalizePath(command));
}

function originalStatusLine() {
  if (manifest?.statusline && 'original' in manifest.statusline) return { known: true, value: manifest.statusline.original };
  if (config && 'chain_statusline' in config) return { known: true, value: config.chain_statusline };
  return { known: false, value: null };
}

// ---------- 步驟（FR-8.4）：plan() 回傳要列出的說明，run() 執行並回傳結果 ----------

const steps = [
  {
    label: '建立停用開關',
    plan: () => (isDirectory(stateDir) ? `建立 ${join(stateDir, 'DISABLED')}（之後的步驟失敗時，hooks 也已失效）` : null),
    run: () => {
      if (!isDirectory(stateDir)) return { status: 'absent', message: '狀態資料夾已不存在，略過停用開關' };
      writeFileSync(join(stateDir, 'DISABLED'), `uninstall ${new Date().toISOString()}\n`);
      return { status: 'done', message: '已建立停用開關 DISABLED' };
    },
  },
  {
    label: '結束殘留程序',
    plan: () => {
      const pid = dialogPid();
      return pid && isAlive(pid) ? `結束殘留的對話框程序（PID ${pid}）並釋放鎖` : null;
    },
    run: () => {
      const pid = dialogPid();
      let message = '沒有殘留的對話框程序';
      if (pid && isAlive(pid)) {
        try {
          process.kill(pid);
          message = `已結束對話框程序（PID ${pid}）`;
        } catch (error) {
          return { status: 'warn', message: `無法結束對話框程序（PID ${pid}）：${error.code}` };
        }
      }
      for (const lock of ['poll.lock', 'prompt.lock']) rmSync(join(stateDir, lock), { recursive: true, force: true });
      return { status: 'done', message };
    },
  },
  {
    label: '備份設定',
    plan: () => `備份設定檔到 ${backupDir}`,
    run: () => {
      const files = [
        ['settings.json', settingsPath],
        ['settings.local.json', join(claudeDir, 'settings.local.json')],
        ['installed_plugins.json', join(claudeDir, 'plugins', 'installed_plugins.json')],
        ['known_marketplaces.json', join(claudeDir, 'plugins', 'known_marketplaces.json')],
      ].filter(([, source]) => exists(source));
      if (!files.length) return { status: 'absent', message: '沒有需要備份的設定檔' };
      mkdirSync(backupDir, { recursive: true });
      for (const [name, source] of files) copyFileSync(source, join(backupDir, name));
      return { status: 'done', message: `已備份 ${files.map(([name]) => name).join('、')} 到 ${backupDir}` };
    },
  },
  {
    label: '還原 statusLine',
    plan: () => {
      const settings = readJson(settingsPath, null);
      if (!settings?.statusLine) return null;
      if (!isOurStatusLine(settings.statusLine)) return null;
      const { value } = originalStatusLine();
      return value ? `還原 statusLine 為原本的指令：${value.command ?? value}` : '還原 statusLine：移除 statusLine 設定（安裝前沒有）';
    },
    run: () => {
      if (!exists(settingsPath)) return { status: 'absent', message: 'settings.json 不存在，statusLine 不需還原' };
      // 先讀取、再合併、最後寫回：只改 statusLine 一個鍵（FR-8.4 步驟 4）。
      const settings = readJson(settingsPath, null);
      if (!settings) return { status: 'warn', message: `${settingsPath} 不是合法 JSON，未還原 statusLine，請手動檢查` };
      if (!settings.statusLine || !isOurStatusLine(settings.statusLine)) {
        const changed = manifest?.statusline?.installed && settings.statusLine;
        return changed
          ? { status: 'done', message: 'statusLine 已被改過，保留不動' }
          : { status: 'absent', message: 'statusLine 不是本工具設定的，已不存在需還原的項目' };
      }
      const { known, value } = originalStatusLine();
      const next = { ...settings };
      if (value) next.statusLine = value;
      else delete next.statusLine;
      writeJsonAtomic(settingsPath, next);
      if (!known) return { status: 'warn', message: `找不到原本的 statusLine，已移除 statusLine 設定；備份在 ${backupDir}` };
      return { status: 'done', message: value ? '已還原原本的 statusLine' : '已移除 statusLine 設定（安裝前沒有）' };
    },
  },
  {
    label: '移除 plugin',
    plan: () => (options.skipClaude ? null : ourInstalls.map((p) => `移除 plugin ${p.id}（${p.scope}${p.projectPath ? `，${p.projectPath}` : ''}）`).join('\n  - ') || null),
    run: () => {
      if (options.skipClaude) return { status: 'absent', message: '--skip-claude：略過 plugin 移除' };
      if (!pluginsBefore) return { status: 'warn', message: '無法執行 claude plugin list，略過 plugin 移除。請手動執行 claude plugin uninstall usage-sentinel@<市集> --scope <範圍>' };
      if (!ourInstalls.length) return { status: 'absent', message: 'plugin 已不存在於任何範圍' };
      const messages = [];
      let status = 'done';
      for (const plugin of ourInstalls) {
        const result = runClaude(['plugin', 'uninstall', plugin.id, '--scope', plugin.scope, '--json'], { cwd: plugin.projectPath || undefined });
        if (result.ok && parseJson(result.stdout)?.success !== false) {
          messages.push(`已移除 ${plugin.id}（${plugin.scope}）`);
          continue;
        }
        // project 範圍可能卡死（#73697）：改為直接刪除該範圍設定檔的 enabledPlugins 項目。
        status = 'warn';
        const file = scopeSettingsFile(plugin);
        const settings = readJson(file, null);
        if (settings?.enabledPlugins && plugin.id in settings.enabledPlugins) {
          delete settings.enabledPlugins[plugin.id];
          writeJsonAtomic(file, settings);
        }
        messages.push(
          `claude plugin uninstall 失敗（${plugin.id}，${plugin.scope}），已直接從 ${file} 刪除 enabledPlugins 項目。` +
            `手動修復：在 ${plugin.projectPath || '任意目錄'} 執行 claude plugin uninstall ${plugin.id} --scope ${plugin.scope}，並確認 ${file} 已沒有 ${plugin.id}`,
        );
      }
      return { status, message: messages.join('\n  ') };
    },
  },
  {
    label: '移除市集宣告',
    plan: () => (options.skipClaude || !ourMarkets.length ? null : `移除市集宣告 ${ourMarkets.join('、')}（若市集已沒有其他安裝中的 plugin）`),
    run: () => {
      if (options.skipClaude) return { status: 'absent', message: '--skip-claude：略過市集宣告' };
      if (!ourMarkets.length) return { status: 'absent', message: '市集宣告已不存在' };
      const remaining = listPlugins() ?? [];
      const messages = [];
      for (const market of ourMarkets) {
        // 只移除本工具的專屬市集；還有其他安裝中的 plugin 時保留。
        const others = remaining.filter((p) => !isOurs(p) && marketOf(p.id) === market);
        if (market !== 'usage-sentinel' || others.length) {
          messages.push(`保留市集 ${market}（不是專屬市集，或還有其他 plugin：${others.map((p) => p.id).join('、') || '無'}）`);
          continue;
        }
        const result = runClaude(['plugin', 'marketplace', 'remove', market]);
        messages.push(result.ok ? `已移除市集宣告 ${market}` : `移除市集宣告 ${market} 失敗，請手動執行 claude plugin marketplace remove ${market}`);
      }
      return { status: messages.some((m) => m.includes('失敗')) ? 'warn' : 'done', message: messages.join('\n  ') };
    },
  },
  {
    label: '清除 plugin cache',
    plan: () => {
      if (options.skipClaude) return null;
      const dirs = ourMarkets.map(cacheDirOf).filter(exists);
      if (!dirs.length) return null;
      return sessionsRunning ? `保留 plugin cache 給 Claude Code 自行回收（有 session 開著）：${dirs.join('、')}` : `刪除 plugin cache ${dirs.join('、')}`;
    },
    run: () => {
      if (options.skipClaude) return { status: 'absent', message: '--skip-claude：略過 plugin cache' };
      const dirs = ourMarkets.map(cacheDirOf).filter(exists);
      if (!dirs.length) return { status: 'absent', message: 'plugin cache 已不存在' };
      // 只在確認沒有執行中的 session 時才刪，否則留給 Claude Code 依 .orphaned_at 回收（E9）。
      if (sessionsRunning) return { status: 'done', message: `保留 plugin cache 給 Claude Code 自行回收：${dirs.join('、')}` };
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return { status: 'done', message: `已刪除 plugin cache ${dirs.join('、')}` };
    },
  },
  {
    label: '刪除狀態資料夾',
    plan: () => (exists(stateDir) ? `刪除狀態資料夾 ${stateDir}（含 config、快取、events.log、bin、manifest）` : null),
    run: () => {
      if (!exists(stateDir)) return { status: 'absent', message: `狀態資料夾已不存在：${stateDir}` };
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return exists(stateDir)
        ? { status: 'warn', message: `無法完整刪除 ${stateDir}，可能有檔案被占用` }
        : { status: 'done', message: `已刪除狀態資料夾 ${stateDir}` };
    },
  },
  {
    label: '處理備份',
    plan: () => (options.purge ? `刪除備份資料夾 ${backupsRoot}` : `保留備份資料夾 ${backupsRoot}（加 --purge 會一併刪除）`),
    run: ({ purgeBackups }) => {
      if (!purgeBackups) return { status: 'done', message: `保留備份資料夾 ${backupsRoot}` };
      if (!exists(backupsRoot)) return { status: 'absent', message: '備份資料夾已不存在' };
      rmSync(backupsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return { status: 'done', message: `已刪除備份資料夾 ${backupsRoot}` };
    },
  },
];

// ---------- 殘留自我檢查（FR-8.5） ----------

const checks = [
  () => (exists(stateDir) ? { mark: '⚠️', text: `狀態資料夾仍存在：${stateDir}（手動刪除：rmdir /s "${stateDir}"）` } : { mark: '✅', text: '狀態資料夾已清除' }),
  () => {
    const settings = readJson(settingsPath, null);
    return settings?.statusLine && isOurStatusLine(settings.statusLine)
      ? { mark: '⚠️', text: `settings.json 的 statusLine 仍指向本工具（手動編輯 ${settingsPath} 的 statusLine）` }
      : { mark: '✅', text: 'statusLine 不再指向本工具' };
  },
  () => {
    const pid = dialogPid();
    return pid && isAlive(pid)
      ? { mark: '⚠️', text: `對話框程序仍在執行（PID ${pid}，手動結束：taskkill /PID ${pid} /F）` }
      : { mark: '✅', text: '沒有本工具的對話框程序' };
  },
  ...(options.skipClaude ? [] : claudeChecks()),
];

// 設定檔裡還有沒有本工具的項目：enabledPlugins、市集宣告、指向本工具的 hooks／statusLine。
function settingsLeftovers(file) {
  const settings = readJson(file, null);
  if (!settings) return [];
  const found = Object.keys(settings.enabledPlugins ?? {}).filter((id) => id.startsWith('usage-sentinel@'));
  if ('usage-sentinel' in (settings.extraKnownMarketplaces ?? {})) found.push('extraKnownMarketplaces.usage-sentinel');
  if (/usage-sentinel/i.test(JSON.stringify(settings.hooks ?? {}))) found.push('hooks');
  if (settings.statusLine && isOurStatusLine(settings.statusLine)) found.push('statusLine');
  return found;
}

function claudeChecks() {
  const settingsFiles = [
    settingsPath,
    join(claudeDir, 'settings.local.json'),
    join(process.cwd(), '.claude', 'settings.json'),
    join(process.cwd(), '.claude', 'settings.local.json'),
  ];
  return [
    // 不能只相信 uninstall 回傳的成功訊息（#83891），重新列出確認。
    () => {
      const list = listPlugins();
      if (!list) return { mark: '⚠️', text: '無法執行 claude plugin list，請手動確認 plugin 已移除' };
      const left = list.filter(isOurs);
      return left.length
        ? { mark: '⚠️', text: `仍列出 ${left.map((p) => `${p.id}（${p.scope}）`).join('、')}（手動：claude plugin uninstall <id> --scope <範圍>）` }
        : { mark: '✅', text: '所有範圍都已沒有本 plugin' };
    },
    () => {
      const left = settingsFiles.flatMap((file) => settingsLeftovers(file).map((item) => `${file}：${item}`));
      return left.length ? { mark: '⚠️', text: `設定檔仍有本工具的項目：${left.join('；')}（請手動刪除）` } : { mark: '✅', text: '設定檔已沒有本工具的項目' };
    },
    () =>
      'usage-sentinel' in (readJson(knownMarketplacesPath, {}) ?? {})
        ? { mark: '⚠️', text: '市集 usage-sentinel 仍在 known_marketplaces.json（手動：claude plugin marketplace remove usage-sentinel）' }
        : { mark: '✅', text: '市集宣告已清除' },
    () => {
      const dataDir = join(claudeDir, 'plugins', 'data');
      const left = exists(dataDir) ? readdirSync(dataDir).filter((name) => name.startsWith('usage-sentinel')) : [];
      return left.length ? { mark: '⚠️', text: `plugins/data 仍有 ${left.join('、')}（手動刪除 ${dataDir} 底下這些資料夾）` } : { mark: '✅', text: 'plugins/data 已清除' };
    },
    () => {
      const cacheRoot = join(claudeDir, 'plugins', 'cache');
      const left = exists(cacheRoot) ? readdirSync(cacheRoot).map(cacheDirOf).filter(exists) : [];
      if (!left.length) return { mark: '✅', text: 'plugin cache 已清除' };
      const orphaned = left.every((dir) => readdirSync(dir).some((version) => exists(join(dir, version, '.orphaned_at'))));
      return orphaned
        ? { mark: '⏳', text: `plugin cache 待 Claude Code 自行回收：${left.join('、')}` }
        : { mark: '⚠️', text: `plugin cache 仍存在：${left.join('、')}（關閉所有 Claude Code 後手動刪除）` };
    },
  ];
}

// ---------- 主流程 ----------

async function* lines() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) yield line;
}
const input = lines();
async function ask(question) {
  process.stdout.write(question);
  const { value, done } = await input.next();
  if (!process.stdin.isTTY) process.stdout.write('\n');
  return done ? null : value;
}

const say = (text = '') => process.stdout.write(text + '\n');

say('usage-sentinel 移除工具');
say();

// 步驟 0：舊 session 會把啟動時的設定快照寫回磁碟，讓已移除的 plugin 或 statusLine 復活（#76570）。
if (sessions === null) {
  say('⚠️ 無法取得程序清單，無法確認是否有 Claude Code 開著。請先關閉所有 Claude Code（終端機與 VS Code）。');
  say();
} else if (sessions.length) {
  say('偵測到執行中的 Claude Code：');
  for (const p of sessions) say(`  - PID ${p.pid}  ${p.path || p.name}`);
  say();
  if (!options.force && !options.dryRun) {
    say('請先關閉這些 Claude Code（終端機與 VS Code 視窗）再執行移除。若確定要繼續，加上 --force。');
    process.exit(1);
  }
  say('（--force：繼續執行；plugin cache 會保留給 Claude Code 自行回收）');
  say();
}

const planned = steps.map((step) => step.plan()).filter(Boolean);
if (planned.length) {
  say('將移除以下項目：');
  for (const item of planned) say(`  - ${item}`);
} else {
  say('沒有找到需要移除的項目，以下各項已不存在。');
}
say();

if (options.dryRun) {
  say('（--dry-run：只列出清單，沒有做任何變更）');
  process.exit(0);
}

if (!options.yes) {
  const answer = await ask('按 Enter 繼續，輸入其他內容取消：');
  if (answer === null || answer.trim() !== '') {
    say('已取消，沒有做任何變更。');
    process.exit(1);
  }
}

let purgeBackups = options.purge;
if (!options.yes && !options.purge) {
  const answer = await ask(`是否也刪除備份資料夾 ${backupsRoot}？[y/N]：`);
  purgeBackups = /^y(es)?$/i.test(answer?.trim() ?? '');
}

for (const step of steps) {
  let result;
  try {
    result = step.run({ purgeBackups });
  } catch (error) {
    result = { status: 'warn', message: `${step.label}失敗：${error.code || error.message}` };
  }
  const mark = { done: '✓', absent: '·', warn: '⚠️' }[result.status];
  say(`${mark} ${result.message}${result.status === 'absent' && !/已不存在/.test(result.message) ? '（已不存在）' : ''}`);
}

say();
say('移除後檢查：');
const results = checks.map((check) => check());
for (const { mark, text } of results) say(`  ${mark} ${text}`);
say();
say('若移除時有 session 開著（用了 --force），請重開它們或在其中執行 /reload-plugins，並在 5 分鐘後再執行一次 --dry-run 確認沒有復活。');
process.exitCode = results.some((r) => r.mark === '⚠️') ? 1 : 0;
