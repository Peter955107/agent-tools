// 用量資料：正規化與取得。目前只支援 fake-usage.json；端點輪詢在任務 4 加入。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WINDOWS } from './state.mjs';

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

export function getUsage({ dir, nowMs }) {
  return readFakeUsage(dir, nowMs);
}
