import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildStopDialog, powershellLaunch, showDialog } from '../scripts/dialog.mjs';
import { ROOT } from '../test-support/helpers.mjs';

const FAKE = join(ROOT, 'test-support', 'fake-dialog.mjs');
const fakeLaunch = (...args) => () => ({ command: process.execPath, args: [FAKE, ...args], env: process.env });

const spec = {
  title: '標題',
  body: '內文',
  buttons: [
    { id: 'continue', label: '繼續' },
    { id: 'until_reset', label: '到重置前不再問' },
    { id: 'stop', label: '停止' },
  ],
  defaultId: 'stop',
  timeoutSeconds: 5,
};

describe('powershellLaunch', () => {
  const launch = powershellLaunch(spec);

  test('以 -EncodedCommand 執行 Windows PowerShell，並帶 -STA', () => {
    assert.equal(launch.command, 'powershell.exe');
    assert.ok(launch.args.includes('-STA'));
    assert.ok(launch.args.includes('-NoProfile'));
    assert.equal(launch.args.at(-2), '-EncodedCommand');
  });

  test('腳本為 UTF-16LE base64，內容是 TopMost 的 WinForms 對話框', () => {
    const script = Buffer.from(launch.args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /System\.Windows\.Forms/);
    assert.match(script, /TopMost = \$true/);
  });

  test('文字一律經由環境變數傳遞，不嵌入腳本', () => {
    const script = Buffer.from(launch.args.at(-1), 'base64').toString('utf16le');
    assert.equal(script.includes('繼續'), false);
    assert.equal(launch.env.USAGE_SENTINEL_DIALOG_TITLE, '標題');
    assert.equal(launch.env.USAGE_SENTINEL_DIALOG_BODY, '內文');
    assert.equal(launch.env.USAGE_SENTINEL_DIALOG_BUTTONS, '繼續\n到重置前不再問\n停止');
    assert.equal(launch.env.USAGE_SENTINEL_DIALOG_DEFAULT, '2');
  });
});

describe('showDialog', () => {
  test('回傳按下的按鈕 id，忽略 stderr 雜訊', async () => {
    const result = await showDialog(spec, { launch: fakeLaunch('0') });
    assert.equal(result.choice, 'continue');
    assert.equal(typeof result.elapsedMs, 'number');
  });

  test('按下第三個按鈕', async () => {
    assert.equal((await showDialog(spec, { launch: fakeLaunch('2') })).choice, 'stop');
  });

  test('關閉視窗（沒有選擇）回傳 dismissed', async () => {
    assert.equal((await showDialog(spec, { launch: fakeLaunch('-1') })).choice, 'dismissed');
  });

  test('逾時：結束對話框程序並回傳 timeout', async () => {
    const started = Date.now();
    const result = await showDialog({ ...spec, timeoutSeconds: 0.3 }, { launch: fakeLaunch('0', '10000') });
    assert.equal(result.choice, 'timeout');
    assert.ok(Date.now() - started < 3000, '應在逾時後立即返回');
  });

  test('回報對話框程序的 PID（供死鎖回收與移除時結束程序）', async () => {
    let pid;
    await showDialog(spec, { launch: fakeLaunch('0'), onSpawn: (p) => (pid = p) });
    assert.equal(typeof pid, 'number');
  });

  test('指令不存在時回傳 unavailable', async () => {
    const launch = () => ({ command: 'usage-sentinel-no-such-command', args: [], env: process.env });
    assert.equal((await showDialog(spec, { launch })).choice, 'unavailable');
  });

  test('程序異常結束且沒有輸出時回傳 unavailable', async () => {
    assert.equal((await showDialog(spec, { launch: fakeLaunch('', '0', '1') })).choice, 'unavailable');
  });

  test('輸出無法解析時回傳 unavailable', async () => {
    assert.equal((await showDialog(spec, { launch: fakeLaunch('garbage') })).choice, 'unavailable');
  });

  test('非 Windows 平台目前回傳 unavailable（交給 ask 備援）', async () => {
    assert.equal((await showDialog(spec, { platform: 'linux' })).choice, 'unavailable');
  });
});

describe('buildStopDialog', () => {
  const NOW_MS = 1_800_000_000_000;
  const now = NOW_MS / 1000;

  test('5 小時視窗：內文含百分比、重置倒數、專案與 session，三個按鈕、預設停止', () => {
    const dialog = buildStopDialog({
      trigger: { window: 'five_hour', pct: 93, resets_at: now + 72 * 60 },
      project: 'my-app',
      sessionId: 'fe002f2b-9f93-4e37-8224-ee4a7bedcae4',
      nowMs: NOW_MS,
      timeoutSeconds: 90,
    });
    assert.match(dialog.body, /5 小時用量 93%，1 小時 12 分後重置/);
    assert.match(dialog.body, /專案：my-app/);
    assert.match(dialog.body, /session：fe002f2b/);
    assert.match(dialog.body, /90 秒內沒有回應會自動停止/);
    assert.deepEqual(dialog.buttons.map((b) => b.id), ['continue', 'until_reset', 'stop']);
    assert.equal(dialog.defaultId, 'stop');
    assert.equal(dialog.timeoutSeconds, 90);
  });

  test('7 天視窗：不提供「到重置前不再問」，並加註撞牆警告', () => {
    const dialog = buildStopDialog({
      trigger: { window: 'seven_day', pct: 94, resets_at: now + 2 * 86400 + 5 * 3600 },
      project: 'my-app',
      sessionId: 's',
      nowMs: NOW_MS,
      timeoutSeconds: 90,
    });
    assert.deepEqual(dialog.buttons.map((b) => b.id), ['continue', 'stop']);
    assert.match(dialog.body, /繼續可能撞牆，需等 2 天 5 小時才會重置/);
  });

  test('fake 資料在標題標示 FAKE', () => {
    const dialog = buildStopDialog({
      trigger: { window: 'five_hour', pct: 93, resets_at: now + 60 },
      project: 'p',
      sessionId: 's',
      nowMs: NOW_MS,
      timeoutSeconds: 90,
      fake: true,
    });
    assert.match(dialog.title, /FAKE/);
  });
});
