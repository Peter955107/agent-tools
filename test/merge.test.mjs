import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../scripts/state.mjs';
import { assessUsage, mergeWindow } from '../scripts/usage.mjs';

const RESET = 1_900_000_000;

function win(pct, observedAt, { resetsAt = RESET, source = 'endpoint' } = {}) {
  return { window: 'five_hour', pct, resets_at: resetsAt, observed_at: observedAt, source };
}

describe('mergeWindow', () => {
  test('沒有舊資料時直接採用新資料', () => {
    assert.deepEqual(mergeWindow(undefined, win(40, 100)), win(40, 100));
  });

  test('同一週期、較新且較高：採用新資料', () => {
    assert.deepEqual(mergeWindow(win(40, 100), win(45, 200, { source: 'statusline' })), win(45, 200, { source: 'statusline' }));
  });

  test('同一週期、較新但較低：百分比不下降，時間與來源更新', () => {
    const merged = mergeWindow(win(38, 100), win(37, 200, { source: 'statusline' }));
    assert.equal(merged.pct, 38);
    assert.equal(merged.observed_at, 200);
    assert.equal(merged.source, 'statusline');
  });

  test('同一週期、較舊但較高：百分比取高，時間保留較新者', () => {
    const merged = mergeWindow(win(40, 200), win(42, 100));
    assert.equal(merged.pct, 42);
    assert.equal(merged.observed_at, 200);
  });

  test('重置時間只差小數秒（端點每次回傳不同的微秒）仍視為同一週期', () => {
    const merged = mergeWindow(win(50, 100, { resetsAt: RESET + 0.833 }), win(49, 200, { resetsAt: RESET + 0.38 }));
    assert.equal(merged.pct, 50);
  });

  test('不同週期：以較新的觀察為準（重置後可以下降）', () => {
    const merged = mergeWindow(win(95, 100), win(3, 200, { resetsAt: RESET + 18_000 }));
    assert.equal(merged.pct, 3);
    assert.equal(merged.resets_at, RESET + 18_000);
  });

  test('不同週期且新資料較舊：保留現有資料', () => {
    const existing = win(3, 200, { resetsAt: RESET + 18_000 });
    assert.deepEqual(mergeWindow(existing, win(95, 100)), existing);
  });
});

describe('assessUsage', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const NOW_MS = 1_800_000_000_000;
  const NOW = NOW_MS / 1000;
  const snapshot = (observedAt, source = 'endpoint') => ({
    source,
    observed_at: observedAt,
    windows: { five_hour: win(50, observedAt, { source }) },
  });

  test('資料新鮮時可用', () => {
    assert.deepEqual(assessUsage(snapshot(NOW - 600), {}, config, NOW_MS), { available: true });
  });

  test('fake 資料一律可用', () => {
    assert.equal(assessUsage(snapshot(NOW - 99_999, 'fake'), {}, config, NOW_MS).available, true);
  });

  const reasons = [
    ['尚未取得', null, {}],
    ['token 已過期，等 Claude Code 刷新', null, { status: { code: 'token_expired' } }],
    ['憑證無效', null, { status: { code: 'credentials_invalid' } }],
    ['429 退避中（剩 120 秒）', null, { status: { code: 'rate_limited' }, backoff_until: NOW + 120 }],
    ['網路錯誤（ETIMEDOUT）', null, { status: { code: 'network_error', detail: 'ETIMEDOUT' } }],
    ['回應格式改變（欄位：a, b）', null, { status: { code: 'schema_changed', fields: ['a', 'b'] } }],
    ['資料已過期 12 分鐘', NOW - 720, { status: { code: 'ok' } }],
  ];
  for (const [text, observedAt, poll] of reasons) {
    test(`不可用原因：${text}`, () => {
      const result = assessUsage(observedAt ? snapshot(observedAt) : null, poll, config, NOW_MS);
      assert.equal(result.available, false);
      assert.equal(result.reason, text);
    });
  }

  test('資料過期且輪詢失敗時，同時列出兩個原因', () => {
    const result = assessUsage(snapshot(NOW - 720), { status: { code: 'rate_limited' }, backoff_until: NOW + 60 }, config, NOW_MS);
    assert.equal(result.reason, '429 退避中（剩 60 秒）；資料已過期 12 分鐘');
  });
});
