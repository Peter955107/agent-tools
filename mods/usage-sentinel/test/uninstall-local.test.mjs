import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, isolatedEnv, tempDir } from '../test-support/helpers.mjs';

const SCRIPT = join(ROOT, 'scripts', 'uninstall.mjs');
const HUD = { type: 'command', command: "bash -c 'node ~/hud.js'", padding: 0 };

// 模擬「安裝過 statusLine 的使用者」：settings.json、狀態資料夾、manifest、config 都齊全。
function installed({ statusLine, original = HUD } = {}) {
  const claude = tempDir();
  const dir = join(claude, 'usage-sentinel');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const ours = { type: 'command', command: `node "${join(dir, 'bin', 'statusline.mjs').replace(/\\/g, '/')}"`, padding: 0 };
  const settings = { model: 'opus', permissions: { allow: ['Bash(git:*)'] }, statusLine: statusLine ?? ours };
  writeFileSync(join(claude, 'settings.json'), JSON.stringify(settings, null, 2));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ chain_statusline: original }));
  writeFileSync(join(dir, 'cache.json'), '{}');
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ tool: 'usage-sentinel', state_dir: dir, statusline: { installed: true, command: ours.command, original } }),
  );
  copyFileSync(join(ROOT, 'scripts', 'statusline.mjs'), join(dir, 'bin', 'statusline.mjs'));
  return { claude, dir, settings, ours };
}

// --skip-claude：任務 14 只測本機步驟，不呼叫 claude CLI。
function uninstall(claude, args = ['--yes'], { input = '', script = SCRIPT } = {}) {
  const result = spawnSync(process.execPath, [script, '--skip-claude', ...args], {
    input,
    env: isolatedEnv({ USAGE_SENTINEL_DIR: join(claude, 'usage-sentinel'), CLAUDE_CONFIG_DIR: claude }),
    encoding: 'utf8',
    timeout: 30000,
  });
  return { code: result.status, out: result.stdout + result.stderr };
}

const settingsOf = (claude) => JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8'));

describe('uninstall.mjs 本機部分', () => {
  test('--dry-run 只列出將移除的項目，不動任何東西', () => {
    const { claude, dir, settings } = installed();
    const { code, out } = uninstall(claude, ['--dry-run']);
    assert.equal(code, 0, out);
    assert.match(out, /將移除/);
    assert.match(out, /還原 statusLine/);
    assert.match(out, /刪除狀態資料夾/);
    assert.deepEqual(settingsOf(claude), settings);
    assert.ok(existsSync(dir));
    assert.equal(existsSync(join(dir, 'DISABLED')), false);
  });

  test('--yes：還原 statusLine、其他設定不變、刪除狀態資料夾，自我檢查全部通過（驗收 11）', () => {
    const { claude, dir, settings } = installed();
    const { code, out } = uninstall(claude);
    assert.equal(code, 0, out);
    assert.deepEqual(settingsOf(claude), { ...settings, statusLine: HUD });
    assert.equal(existsSync(dir), false);
    assert.doesNotMatch(out, /⚠️/);
    assert.match(out, /✅/);
  });

  test('原本沒有 statusLine 時，移除 statusLine 鍵', () => {
    const { claude } = installed({ original: null });
    uninstall(claude);
    assert.equal('statusLine' in settingsOf(claude), false);
  });

  test('使用者在安裝後改過 statusLine 時不動它，並提示', () => {
    const mine = { type: 'command', command: 'echo mine' };
    const { claude } = installed({ statusLine: mine });
    const { code, out } = uninstall(claude);
    assert.equal(code, 0, out);
    assert.deepEqual(settingsOf(claude).statusLine, mine);
    assert.match(out, /statusLine 已被改過，保留不動/);
  });

  test('移除前備份設定檔', () => {
    const { claude } = installed();
    const before = readFileSync(join(claude, 'settings.json'), 'utf8');
    uninstall(claude);
    const backups = join(claude, 'backups', 'usage-sentinel');
    const [run] = readdirSync(backups).filter((name) => name.endsWith('-uninstall'));
    assert.equal(readFileSync(join(backups, run, 'settings.json'), 'utf8'), before);
  });

  test('預設保留備份；--purge 一併刪除', () => {
    const kept = installed();
    uninstall(kept.claude);
    assert.ok(existsSync(join(kept.claude, 'backups', 'usage-sentinel')));
    const purged = installed();
    uninstall(purged.claude, ['--yes', '--purge']);
    assert.equal(existsSync(join(purged.claude, 'backups', 'usage-sentinel')), false);
  });

  test('連續執行兩次：第二次全部顯示「已不存在」，exit 0（驗收 14）', () => {
    const { claude } = installed();
    uninstall(claude);
    const { code, out } = uninstall(claude);
    assert.equal(code, 0, out);
    assert.match(out, /已不存在/);
    assert.doesNotMatch(out, /⚠️/);
  });

  test('plugin 資料夾已被刪除時，從 bin/ 的副本執行仍能完成（驗收 13）', () => {
    const { claude, dir } = installed();
    const copy = join(dir, 'bin', 'uninstall.mjs');
    copyFileSync(SCRIPT, copy);
    const { code, out } = uninstall(claude, ['--yes'], { script: copy });
    assert.equal(code, 0, out);
    assert.deepEqual(settingsOf(claude).statusLine, HUD);
    assert.equal(existsSync(dir), false);
  });

  test('沒有 manifest 時，依 statusLine 指令路徑辨識並還原', () => {
    const { claude, dir } = installed();
    writeFileSync(join(dir, 'manifest.json'), '{ broken');
    uninstall(claude);
    assert.deepEqual(settingsOf(claude).statusLine, HUD);
  });

  test('結束殘留的對話框程序', async () => {
    const { claude, dir } = installed();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await new Promise((resolve) => child.on('spawn', resolve));
    mkdirSync(join(dir, 'prompt.lock'));
    writeFileSync(join(dir, 'prompt.lock', 'dialog.pid'), String(child.pid));
    const exited = new Promise((resolve) => child.on('exit', resolve));
    uninstall(claude);
    await exited;
    assert.equal(child.exitCode !== null || child.signalCode !== null, true);
  });

  test('互動模式：按 Enter 確認後執行', () => {
    const { claude, dir } = installed();
    const { code } = uninstall(claude, [], { input: '\n\n' });
    assert.equal(code, 0);
    assert.equal(existsSync(dir), false);
  });

  test('互動模式：輸入其他內容則取消，不動任何東西', () => {
    const { claude, dir, settings } = installed();
    const { out } = uninstall(claude, [], { input: 'n\n' });
    assert.match(out, /已取消/);
    assert.ok(existsSync(dir));
    assert.deepEqual(settingsOf(claude), settings);
  });

  test('結尾提示重開 session 並在 5 分鐘後再用 --dry-run 確認', () => {
    const { claude } = installed();
    assert.match(uninstall(claude).out, /5 分鐘後再執行一次 --dry-run/);
  });

  test('單一檔案、不 import 專案內其他模組', () => {
    assert.doesNotMatch(readFileSync(SCRIPT, 'utf8'), /from ['"]\.{1,2}\//);
  });
});
