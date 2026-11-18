// 用量資料：fake-usage.json 或 usage 端點惰性輪詢，正規化後寫入快取（FR-1）。
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { claudeDir } from './gate.mjs';
import { WINDOWS, acquireLock, readJson, releaseLock, writeJson } from './state.mjs';

// 端點與 statusLine 用 0–100，推論請求的 header 用 0–1（E8）；單位由欄位來源決定，不靠數值猜。
export function normalizePct(value, unit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const pct = unit === 'fraction' ? value * 100 : value;
  return Math.min(100, Math.max(0, Math.round(pct * 100) / 100));
}

// 端點用 ISO 字串（含微秒），statusLine 用 epoch 秒；統一成 epoch 秒。
export function normalizeResetsAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms / 1000;
}

// 解析 /api/oauth/usage 的回應。格式不符時回傳 null（FR-1：當作沒有資料）。
export function parseEndpointResponse(body, { observedAt, source }) {
  if (!body || typeof body !== 'object') return null;
  const windows = {};
  for (const window of WINDOWS) {
    const raw = body[window];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'object') return null;
    const pct = normalizePct(raw.utilization, 'percent');
    if (pct === null) return null;
    windows[window] = { window, pct, resets_at: normalizeResetsAt(raw.resets_at), observed_at: observedAt, source };
  }
  return Object.keys(windows).length ? windows : null;
}

// 測試資料注入（§7）：fake-usage.json 與端點回應同格式，視為「剛剛觀察到」。
export function readFakeUsage(dir, nowMs) {
  let body;
  try {
    body = JSON.parse(readFileSync(join(dir, 'fake-usage.json'), 'utf8'));
  } catch {
    return null;
  }
  const observedAt = Math.floor(nowMs / 1000);
  const windows = parseEndpointResponse(body, { observedAt, source: 'fake' });
  return windows ? { source: 'fake', observed_at: observedAt, windows } : null;
}

// 端點每次回傳的重置時間小數秒都不同（.833、.380），差距在 60 秒內就視為同一週期。
export function sameCycle(a, b) {
  if (a.resets_at === null || b.resets_at === null) return a.resets_at === b.resets_at;
  return Math.abs(a.resets_at - b.resets_at) < 60;
}

// 同一週期內下降這麼多代表提前重置（重置券不改 resets_at）；小幅下降只是兩個來源的時間差。
export const RESET_DROP = 10;

// 兩個來源以較新的觀察為準；同一週期內百分比只升不降，避免舊資料蓋掉新資料（FR-1）。
export function mergeWindow(existing, incoming) {
  if (!existing) return incoming;
  if (!sameCycle(existing, incoming)) return incoming.observed_at > existing.observed_at ? incoming : existing;
  const newer = incoming.observed_at >= existing.observed_at ? incoming : existing;
  const older = newer === incoming ? existing : incoming;
  if (older.pct - newer.pct >= RESET_DROP) return newer;
  return { ...newer, pct: Math.max(existing.pct, incoming.pct) };
}

export function mergeWindows(existing = {}, incoming = {}) {
  const merged = { ...existing };
  for (const [name, win] of Object.entries(incoming)) merged[name] = mergeWindow(existing[name], win);
  return merged;
}

export function describePollFailure(poll, now) {
  const status = poll?.status;
  switch (status?.code) {
    case 'token_expired':
      return 'token 已過期，等 Claude Code 刷新';
    case 'credentials_invalid':
      return '憑證無效';
    case 'rate_limited':
      return `429 退避中（剩 ${Math.max(0, Math.ceil((poll.backoff_until ?? now) - now))} 秒）`;
    case 'network_error':
      return status.detail ? `網路錯誤（${status.detail}）` : '網路錯誤';
    case 'schema_changed':
      return `回應格式改變（欄位：${(status.fields ?? []).join(', ') || '無'}）`;
    default:
      return null;
  }
}

// 判斷資料能不能用來做決定（FR-3）。不可用時回傳可區分的原因文字。
export function assessUsage(snapshot, poll, config, nowMs) {
  const now = nowMs / 1000;
  if (snapshot?.source === 'fake') return { available: true };
  const failure = describePollFailure(poll, now);
  if (!snapshot) return { available: false, reason: failure ?? '尚未取得' };
  const age = now - snapshot.observed_at;
  if (age <= config.stale_after_seconds) return { available: true };
  const stale = `資料已過期 ${Math.floor(age / 60)} 分鐘`;
  return { available: false, reason: failure ? `${failure}；${stale}` : stale };
}

const OFFICIAL_ENDPOINT ='https://api.anthropic.com/api/oauth/usage';
const DEFAULT_RETRY_AFTER = 300;
const MAX_BODY_BYTES = 1024 * 1024;

// 覆寫只在測試環境（同時設了 USAGE_SENTINEL_DIR）生效，避免正式環境的 token 被導到別處。
export function endpointUrl(env) {
  return env.USAGE_SENTINEL_DIR && env.USAGE_SENTINEL_ENDPOINT ? env.USAGE_SENTINEL_ENDPOINT : OFFICIAL_ENDPOINT;
}

export function readPollState(dir) {
  return readJson(join(dir, 'poll.json'), {}) ?? {};
}

export function readCache(dir) {
  return readJson(join(dir, 'cache.json'), null);
}

function latestObservedAt(cache) {
  const windows = Object.values(cache?.windows ?? {});
  return windows.length ? Math.max(...windows.map((w) => w.observed_at)) : null;
}

function snapshotFromCache(cache) {
  const windows = Object.values(cache?.windows ?? {});
  if (!windows.length) return null;
  const newest = windows.reduce((a, b) => (b.observed_at > a.observed_at ? b : a));
  return { source: newest.source, observed_at: newest.observed_at, windows: cache.windows };
}

// 每次都重讀；只讀不寫，絕不刷新 token（刷新會輪替 token，可能讓 Claude Code 被登出）。
function readCredentials(env) {
  const oauth = readJson(join(claudeDir(env), '.credentials.json'), null)?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
  return { token: oauth.accessToken, expiresAt: oauth.expiresAt };
}

function fetchUsage(url, token, timeoutMs) {
  return new Promise((resolve) => {
    const request = url.startsWith('https:') ? httpsRequest : httpRequest;
    const req = request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), timeoutMs);
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) req.destroy(Object.assign(new Error('response too large'), { code: 'ETOOLARGE' }));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', () => {});
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      resolve({ error: error.code || error.message });
    });
    req.end();
  });
}

function parseRetryAfter(value) {
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_RETRY_AFTER;
}

// 發一次請求並回傳要寫入 poll.json 的新狀態；成功時一併寫入快取。
async function attemptPoll({ dir, config, env, now, nowMs, timeoutMs }, poll) {
  const credentials = readCredentials(env);
  if (!credentials) {
    return { ...poll, last_attempt_at: now, status: { code: 'credentials_invalid', at: now, detail: 'credentials 檔沒有 accessToken' } };
  }
  // token 過期時不記錄嘗試時間：Claude Code 一刷新，下一次 hook 就能立刻重試。
  if (typeof credentials.expiresAt === 'number' && credentials.expiresAt <= nowMs) {
    return { ...poll, status: { code: 'token_expired', at: now } };
  }

  const next = { ...poll, last_attempt_at: now };
  const response = await fetchUsage(endpointUrl(env), credentials.token, timeoutMs);
  if (response.error) return { ...next, status: { code: 'network_error', at: now, detail: response.error } };

  if (response.status === 429) {
    const seconds = parseRetryAfter(response.headers['retry-after']);
    return { ...next, backoff_until: now + seconds, status: { code: 'rate_limited', at: now } };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ...next,
      backoff_until: now + config.poll_interval_seconds,
      status: { code: 'credentials_invalid', at: now, detail: `HTTP ${response.status}` },
    };
  }
  if (response.status !== 200) return { ...next, status: { code: 'network_error', at: now, detail: `HTTP ${response.status}` } };

  let body = null;
  try {
    body = JSON.parse(response.body);
  } catch {
    // 交給下面當作格式改變處理
  }
  const windows = parseEndpointResponse(body, { observedAt: now, source: 'endpoint' });
  if (!windows) {
    // 只記錄欄位名稱，不記錄內容（FR-1）。
    const fields = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort() : [];
    return { ...next, status: { code: 'schema_changed', at: now, fields } };
  }
  writeJson(join(dir, 'cache.json'), { windows: mergeWindows(readCache(dir)?.windows, windows) });
  return { ...next, status: { code: 'ok', at: now } };
}

// FR-1 來源 A：快取夠舊、不在退避期、搶得到 poll.lock，三者都成立才發請求。
async function pollIfDue(ctx) {
  const { dir, config, now } = ctx;
  const isDue = () => {
    const poll = readPollState(dir);
    const lastSeen = Math.max(latestObservedAt(readCache(dir)) ?? 0, poll.last_attempt_at ?? 0);
    if (now - lastSeen < config.poll_interval_seconds) return null;
    if (poll.backoff_until && now < poll.backoff_until) return null;
    return poll;
  };
  if (!isDue()) return;
  const lockToken = acquireLock(dir, 'poll.lock', { ttlSeconds: 30 });
  if (!lockToken) return;
  try {
    // 搶到鎖後再確認一次：可能有別的程序剛好完成了一次輪詢。
    const poll = isDue();
    if (poll) writeJson(join(dir, 'poll.json'), await attemptPoll(ctx, poll));
  } finally {
    releaseLock(dir, 'poll.lock', lockToken);
  }
}

export async function getUsage({ dir, config, env = process.env, nowMs = Date.now(), timeoutMs = 3000 }) {
  const fake = readFakeUsage(dir, nowMs);
  if (fake) return fake;
  await pollIfDue({ dir, config, env, nowMs, now: Math.floor(nowMs / 1000), timeoutMs });
  return snapshotFromCache(readCache(dir));
}
