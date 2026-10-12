import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock } from '../scripts/state.mjs';
import { endpointUrl, getUsage, readPollState } from '../scripts/usage.mjs';
import { startFakeServer } from '../test-support/fake-server.mjs';
import { tempDir } from '../test-support/helpers.mjs';

const NOW_MS = Date.now();
const config = { poll_interval_seconds: 120 };

const OK_BODY = {
  five_hour: { utilization: 62.0, resets_at: '2026-12-31T00:00:00.123456+00:00' },
  seven_day: { utilization: 38.0, resets_at: '2027-01-03T00:00:00+00:00' },
};

let server;
let dir;
let env;

function writeCredentials({ token = 'tok-123', expiresAt = NOW_MS + 3_600_000 } = {}) {
  writeFileSync(
    join(env.CLAUDE_CONFIG_DIR, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'r', expiresAt } }),
  );
}

beforeEach(async () => {
  server = await startFakeServer();
  const root = tempDir();
  dir = join(root, 'state');
  mkdirSync(dir);
  env = { USAGE_SENTINEL_DIR: dir, USAGE_SENTINEL_ENDPOINT: server.url, CLAUDE_CONFIG_DIR: root };
  writeCredentials();
});

afterEach(() => server.close());

const usage = (nowMs = NOW_MS, extra = {}) => getUsage({ dir, config, env, nowMs, timeoutMs: 300, ...extra });

describe('endpointUrl', () => {
  test('預設為官方端點', () => {
    assert.equal(endpointUrl({}), 'https://api.anthropic.com/api/oauth/usage');
  });

  test('只有同時設了 USAGE_SENTINEL_DIR 才接受覆寫，避免 token 被送到別處', () => {
    assert.equal(endpointUrl({ USAGE_SENTINEL_ENDPOINT: 'http://evil' }), 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(endpointUrl({ USAGE_SENTINEL_ENDPOINT: 'http://x', USAGE_SENTINEL_DIR: '/d' }), 'http://x');
  });
});

describe('getUsage：端點輪詢', () => {
  test('200：帶正確 header 請求、寫入快取並回傳正規化資料', async () => {
    server.respond(200, OK_BODY);
    const snapshot = await usage();
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].headers.authorization, 'Bearer tok-123');
    assert.equal(server.requests[0].headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(snapshot.windows.five_hour.pct, 62);
    assert.equal(snapshot.windows.five_hour.source, 'endpoint');
    assert.equal(readPollState(dir).status.code, 'ok');
  });

  test('快取年齡未達 poll_interval 時不發請求', async () => {
    server.respond(200, OK_BODY);
    await usage();
    const snapshot = await usage(NOW_MS + 119_000);
    assert.equal(server.requests.length, 1);
    assert.equal(snapshot.windows.five_hour.pct, 62);
  });

  test('快取年齡達 poll_interval 時再請求一次', async () => {
    server.respond(200, OK_BODY);
    await usage();
    await usage(NOW_MS + 120_000);
    assert.equal(server.requests.length, 2);
  });

  test('429：依 retry-after 退避，期間不請求並沿用快取', async () => {
    server.respond(200, OK_BODY);
    await usage();
    server.respond(429, {}, { 'retry-after': '200' });
    const t1 = NOW_MS + 130_000;
    const snapshot = await usage(t1);
    assert.equal(snapshot.windows.five_hour.pct, 62);
    const poll = readPollState(dir);
    assert.equal(poll.status.code, 'rate_limited');
    assert.equal(poll.backoff_until, Math.floor(t1 / 1000) + 200);
    await usage(t1 + 199_000);
    assert.equal(server.requests.length, 2);
    server.respond(200, OK_BODY);
    await usage(t1 + 200_000);
    assert.equal(server.requests.length, 3);
  });

  test('429 沒有 retry-after 時退避 300 秒', async () => {
    server.respond(429, {});
    await usage();
    assert.equal(readPollState(dir).backoff_until, Math.floor(NOW_MS / 1000) + 300);
  });

  test('401／403：標記憑證無效，退避 poll_interval', async () => {
    for (const [i, status] of [401, 403].entries()) {
      server.respond(status, { error: 'x' });
      const now = NOW_MS + i * 200_000;
      await usage(now);
      const poll = readPollState(dir);
      assert.equal(poll.status.code, 'credentials_invalid');
      assert.equal(poll.backoff_until, Math.floor(now / 1000) + 120);
    }
  });

  test('逾時：記錄網路錯誤並沿用快取', async () => {
    server.respond(200, OK_BODY);
    await usage();
    server.hang();
    const started = Date.now();
    const snapshot = await usage(NOW_MS + 130_000);
    assert.ok(Date.now() - started < 2000, '應在逾時設定內返回');
    assert.equal(snapshot.windows.five_hour.pct, 62);
    assert.equal(readPollState(dir).status.code, 'network_error');
  });

  test('網路錯誤後，未達 poll_interval 前不重試', async () => {
    server.respond(500, {});
    await usage();
    await usage(NOW_MS + 60_000);
    assert.equal(server.requests.length, 1);
    assert.equal(readPollState(dir).status.code, 'network_error');
  });

  test('回應欄位缺失：標記格式改變，只記錄欄位名稱，不記錄內容', async () => {
    server.respond(200, { usage_v2: { secret_value: 'should-not-be-logged' } });
    const snapshot = await usage();
    assert.equal(snapshot, null);
    const poll = readPollState(dir);
    assert.equal(poll.status.code, 'schema_changed');
    assert.deepEqual(poll.status.fields, ['usage_v2']);
    assert.equal(readFileSync(join(dir, 'poll.json'), 'utf8').includes('should-not-be-logged'), false);
  });

  test('token 已過期：不發請求，標記 token 過期', async () => {
    writeCredentials({ expiresAt: NOW_MS - 1 });
    await usage();
    assert.equal(server.requests.length, 0);
    assert.equal(readPollState(dir).status.code, 'token_expired');
  });

  test('token 過期後一旦 Claude Code 刷新，下一次呼叫立刻重試', async () => {
    writeCredentials({ expiresAt: NOW_MS - 1 });
    await usage();
    writeCredentials({ token: 'tok-new' });
    server.respond(200, OK_BODY);
    await usage(NOW_MS + 1000);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].headers.authorization, 'Bearer tok-new');
  });

  test('沒有 credentials 檔：不發請求，標記憑證無效', async () => {
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, '.credentials.json'), '{}');
    await usage();
    assert.equal(server.requests.length, 0);
    assert.equal(readPollState(dir).status.code, 'credentials_invalid');
  });

  test('絕不修改 credentials 檔', async () => {
    const path = join(env.CLAUDE_CONFIG_DIR, '.credentials.json');
    const before = readFileSync(path, 'utf8');
    server.respond(401, {});
    await usage();
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  test('搶不到 poll.lock 時不等待、不請求，直接用現有快取', async () => {
    acquireLock(dir, 'poll.lock', { ttlSeconds: 30 });
    server.respond(200, OK_BODY);
    assert.equal(await usage(), null);
    assert.equal(server.requests.length, 0);
  });

  test('請求完成後釋放 poll.lock', async () => {
    server.respond(200, OK_BODY);
    await usage();
    assert.ok(acquireLock(dir, 'poll.lock', { ttlSeconds: 30 }));
  });

  test('有 fake-usage.json 時優先使用，不發網路請求', async () => {
    writeFileSync(join(dir, 'fake-usage.json'), JSON.stringify({ five_hour: { utilization: 93, resets_at: null } }));
    const snapshot = await usage();
    assert.equal(server.requests.length, 0);
    assert.equal(snapshot.source, 'fake');
  });
});
