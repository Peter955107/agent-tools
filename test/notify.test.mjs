import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { notificationText, webhookRequest } from '../scripts/notify.mjs';
import { startFakeServer } from '../test-support/fake-server.mjs';
import { ROOT, isolatedEnv, runHook, tempDir } from '../test-support/helpers.mjs';

describe('notificationText', () => {
  test('wind-down：百分比與專案資料夾名稱', () => {
    assert.equal(
      notificationText('wind_down', { window: 'five_hour', pct: 86.4 }, 'my-app'),
      'usage-sentinel：5 小時用量 86%，已進入收尾階段（my-app）',
    );
  });

  test('stop', () => {
    assert.equal(notificationText('stop', { window: 'seven_day', pct: 93 }, 'my-app'), 'usage-sentinel：7 天用量 93%，已達停止門檻（my-app）');
  });
});

describe('webhookRequest', () => {
  test('Slack incoming webhook 送 JSON {text}', () => {
    const request = webhookRequest('https://hooks.slack.com/services/T/B/x', 'hi');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body), { text: 'hi' });
  });

  test('其他（例如 ntfy）送純文字', () => {
    const request = webhookRequest('https://ntfy.sh/my-topic', 'hi');
    assert.equal(request.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(request.body, 'hi');
  });
});

describe('notify-worker.mjs', () => {
  test('送出 webhook（desktop 關閉時不跳 toast）', async () => {
    const server = await startFakeServer();
    server.respond(200, {});
    const env = {
      ...process.env,
      USAGE_SENTINEL_NOTIFY_TEXT: 'usage-sentinel：5 小時用量 86%，已進入收尾階段（my-app）',
      USAGE_SENTINEL_NOTIFY_WEBHOOK: server.url,
      USAGE_SENTINEL_NOTIFY_DESKTOP: '0',
    };
    // 用非同步 spawn：spawnSync 會卡住事件迴圈，同一個程序裡的假 server 就收不到請求。
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(ROOT, 'scripts', 'notify-worker.mjs')], { env, stdio: 'ignore' });
      child.on('close', resolve);
    });
    await server.close();
    assert.equal(code, 0);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].method, 'POST');
  });

  test('webhook 連不上時安靜結束', () => {
    const env = {
      ...process.env,
      USAGE_SENTINEL_NOTIFY_TEXT: 'x',
      USAGE_SENTINEL_NOTIFY_WEBHOOK: 'http://127.0.0.1:9/hook',
      USAGE_SENTINEL_NOTIFY_DESKTOP: '0',
    };
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'notify-worker.mjs')], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
  });
});

describe('guard.mjs 進入 wind-down／stop 時通知（FR-5）', () => {
  const RESET = Math.floor(Date.now() / 1000) + 7200;
  const CWD = join(tempDir(), 'my-app');

  function setup(pct, config) {
    const dir = tempDir();
    writeFileSync(join(dir, 'fake-usage.json'), JSON.stringify({ five_hour: { utilization: pct, resets_at: RESET } }));
    if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    return dir;
  }

  // USAGE_SENTINEL_NOTIFY_STUB：測試用，把通知寫進檔案而不是真的送出。
  function guard(dir, session = 's1', script = 'guard.mjs') {
    const log = join(dir, 'notify-stub.log');
    const result = runHook(script, {
      input: { session_id: session, cwd: CWD, tool_name: 'Read', tool_input: {}, prompt: 'hi' },
      env: { USAGE_SENTINEL_DIR: dir, USAGE_SENTINEL_NOTIFY_STUB: log, USAGE_SENTINEL_DIALOG_STUB: 'continue' },
    });
    assert.equal(result.code, 0, result.stderr);
  }

  const notifications = (dir) =>
    existsSync(join(dir, 'notify-stub.log')) ? readFileSync(join(dir, 'notify-stub.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];

  test('進入 wind-down 時通知一次，跨 session 也只有一次', () => {
    const dir = setup(86);
    guard(dir, 's1');
    guard(dir, 's2');
    const sent = notifications(dir);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, 'usage-sentinel：5 小時用量 86%，已進入收尾階段（my-app）');
    assert.equal(sent[0].desktop, true);
  });

  test('進入 stop 時再通知一次', () => {
    const dir = setup(86);
    guard(dir);
    writeFileSync(join(dir, 'fake-usage.json'), JSON.stringify({ five_hour: { utilization: 93, resets_at: RESET } }));
    guard(dir);
    assert.deepEqual(notifications(dir).map((n) => n.kind), ['wind_down', 'stop']);
  });

  test('warn 不通知', () => {
    const dir = setup(80);
    guard(dir);
    assert.equal(notifications(dir).length, 0);
  });

  test('UserPromptSubmit 也會觸發', () => {
    const dir = setup(86);
    guard(dir, 's1', 'prompt.mjs');
    assert.equal(notifications(dir).length, 1);
  });

  test('desktop 關閉且沒有 webhook 時不通知', () => {
    const dir = setup(86, { notify: { desktop: false, webhook_url: null } });
    guard(dir);
    assert.equal(notifications(dir).length, 0);
  });

  test('只有 webhook 時照常通知，內容不含完整路徑', () => {
    const dir = setup(86, { notify: { desktop: false, webhook_url: 'https://ntfy.sh/x' } });
    guard(dir);
    const [sent] = notifications(dir);
    assert.equal(sent.desktop, false);
    assert.equal(sent.webhook_url, 'https://ntfy.sh/x');
    assert.equal(sent.text.includes(CWD), false);
  });
});
