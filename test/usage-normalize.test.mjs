import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizePct, normalizeResetsAt, parseEndpointResponse, readFakeUsage } from '../scripts/usage.mjs';
import { tempDir } from '../test-support/helpers.mjs';

describe('normalizePct', () => {
  test('0–100 單位原樣保留', () => {
    assert.equal(normalizePct(38, 'percent'), 38);
  });

  test('0–1 單位換算成 0–100', () => {
    assert.equal(normalizePct(0.37, 'fraction'), 37);
  });

  test('超出範圍時夾在 0–100', () => {
    assert.equal(normalizePct(104, 'percent'), 100);
    assert.equal(normalizePct(-1, 'percent'), 0);
  });

  test('非數值回傳 null', () => {
    assert.equal(normalizePct('38', 'percent'), null);
    assert.equal(normalizePct(NaN, 'percent'), null);
  });
});

describe('normalizeResetsAt', () => {
  test('ISO 字串（含微秒）轉成 epoch 秒', () => {
    assert.equal(normalizeResetsAt('2026-10-12T06:40:00.833252+00:00'), Date.UTC(2026, 9, 12, 6, 40, 0, 833) / 1000);
  });

  test('epoch 秒原樣保留', () => {
    assert.equal(normalizeResetsAt(1791787200), 1791787200);
  });

  test('null 或無法解析時回傳 null', () => {
    assert.equal(normalizeResetsAt(null), null);
    assert.equal(normalizeResetsAt('not a date'), null);
  });
});

describe('parseEndpointResponse', () => {
  const observedAt = 1_700_000_000;

  test('解析 five_hour／seven_day 成統一格式', () => {
    const body = {
      five_hour: { utilization: 38.0, resets_at: '2026-10-12T06:40:00.833252+00:00' },
      seven_day: { utilization: 31.0, resets_at: '2026-10-15T00:00:00+00:00' },
      seven_day_opus: null,
    };
    const parsed = parseEndpointResponse(body, { observedAt, source: 'endpoint' });
    assert.deepEqual(parsed.five_hour, {
      window: 'five_hour',
      pct: 38,
      resets_at: Date.UTC(2026, 9, 12, 6, 40, 0, 833) / 1000,
      observed_at: observedAt,
      source: 'endpoint',
    });
    assert.equal(parsed.seven_day.pct, 31);
  });

  test('視窗為 null 時略過該視窗', () => {
    const parsed = parseEndpointResponse(
      { five_hour: null, seven_day: { utilization: 10, resets_at: null } },
      { observedAt, source: 'endpoint' },
    );
    assert.equal(parsed.five_hour, undefined);
    assert.equal(parsed.seven_day.resets_at, null);
  });

  test('utilization 型別不對時視為格式改變（回傳 null）', () => {
    assert.equal(parseEndpointResponse({ five_hour: { utilization: '38' } }, { observedAt, source: 'endpoint' }), null);
  });

  test('兩個視窗都沒有時視為格式改變', () => {
    assert.equal(parseEndpointResponse({ usage: {} }, { observedAt, source: 'endpoint' }), null);
    assert.equal(parseEndpointResponse(null, { observedAt, source: 'endpoint' }), null);
  });
});

describe('readFakeUsage', () => {
  test('沒有 fake-usage.json 時回傳 null', () => {
    assert.equal(readFakeUsage(tempDir(), 1000), null);
  });

  test('讀取端點格式的假資料，來源標為 fake、時間為現在', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'fake-usage.json'), JSON.stringify({ five_hour: { utilization: 93, resets_at: 2000 } }));
    const snapshot = readFakeUsage(dir, 1_000_000);
    assert.equal(snapshot.source, 'fake');
    assert.equal(snapshot.observed_at, 1000);
    assert.equal(snapshot.windows.five_hour.pct, 93);
    assert.equal(snapshot.windows.five_hour.source, 'fake');
  });
});
