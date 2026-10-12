// 一鍵移除 usage-sentinel（FR-8）。
// 會被複製到 ~/.claude/usage-sentinel/bin/，plugin 損壞或已刪除、Claude Code 沒開時也要能執行，
// 所以只依賴 Node 內建模組，不 import 專案內其他檔案。
//
// 用法：node ~/.claude/usage-sentinel/bin/uninstall.mjs [--yes] [--dry-run] [--purge] [--force] [--skip-claude]
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
];

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

const planned = steps.map((step) => step.plan()).filter(Boolean);
say('usage-sentinel 移除工具');
say();
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
