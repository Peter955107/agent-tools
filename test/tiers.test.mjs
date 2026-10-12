import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../scripts/state.mjs';
import { computeTier, effectivePct, formatDuration, injectionText } from '../scripts/tiers.mjs';

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;

function snapshot(windows) {
  const out = {};
  for (const [window, pct, resetsIn = 3600] of windows) {
    out[window] = { window, pct, resets_at: NOW + resetsIn, observed_at: NOW, source: 'fake' };
  }
  return { source: 'fake', observed_at: NOW, windows: out };
}

const config = structuredClone(DEFAULT_CONFIG);

describe('effectivePct', () => {
  test('重置時間已過的視窗視為 0%', () => {
    assert.equal(effectivePct({ pct: 95, resets_at: NOW - 1 }, NOW_MS), 0);
  });

  test('尚未重置時用原值', () => {
    assert.equal(effectivePct({ pct: 95, resets_at: NOW + 1 }, NOW_MS), 95);
  });

  test('沒有重置時間時用原值', () => {
    assert.equal(effectivePct({ pct: 40, resets_at: null }, NOW_MS), 40);
  });
});

describe('computeTier', () => {
  const cases = [
    [74.9, 'normal'],
    [75, 'warn'],
    [84.9, 'warn'],
    [85, 'wind_down'],
    [91.9, 'wind_down'],
    [92, 'stop'],
  ];
  for (const [pct, tier] of cases) {
    test(`${pct}% → ${tier}`, () => {
      assert.equal(computeTier(snapshot([['five_hour', pct]]), config, NOW_MS).tier, tier);
    });
  }

  test('取所有視窗中最嚴重的分段，並指出觸發的視窗', () => {
    const result = computeTier(snapshot([['five_hour', 50], ['seven_day', 88]]), config, NOW_MS);
    assert.equal(result.tier, 'wind_down');
    assert.equal(result.trigger.window, 'seven_day');
    assert.equal(result.trigger.pct, 88);
  });

  test('同分段時以百分比較高者為觸發視窗', () => {
    const result = computeTier(snapshot([['five_hour', 80], ['seven_day', 78]]), config, NOW_MS);
    assert.equal(result.trigger.window, 'five_hour');
  });

  test('未啟用的視窗不列入判斷', () => {
    const fiveOnly = { ...config, windows: ['five_hour'] };
    assert.equal(computeTier(snapshot([['five_hour', 10], ['seven_day', 95]]), fiveOnly, NOW_MS).tier, 'normal');
  });

  test('已重置的視窗不觸發', () => {
    assert.equal(computeTier(snapshot([['five_hour', 95, -10]]), config, NOW_MS).tier, 'normal');
  });

  test('使用自訂門檻', () => {
    const custom = { ...config, thresholds: { warn: 50, wind_down: 60, stop: 70 } };
    assert.equal(computeTier(snapshot([['five_hour', 55]]), custom, NOW_MS).tier, 'warn');
  });
});

describe('formatDuration', () => {
  test('小於一小時只顯示分鐘', () => {
    assert.equal(formatDuration(12 * 60), '12 分');
  });

  test('小時與分鐘', () => {
    assert.equal(formatDuration(2 * 3600 + 10 * 60), '2 小時 10 分');
  });

  test('超過一天顯示天與小時', () => {
    assert.equal(formatDuration(3 * 86400 + 4 * 3600 + 59), '3 天 4 小時');
  });

  test('負數或零顯示 0 分', () => {
    assert.equal(formatDuration(-5), '0 分');
  });
});

describe('injectionText', () => {
  test('warn：一行用量資訊，含各視窗百分比與重置倒數', () => {
    const result = computeTier(snapshot([['five_hour', 78, 2 * 3600 + 600], ['seven_day', 40, 3 * 86400]]), config, NOW_MS);
    const text = injectionText(result, config, NOW_MS);
    assert.equal(text.includes('\n'), false);
    assert.match(text, /5 小時用量 78%（2 小時 10 分後重置）/);
    assert.match(text, /7 天用量 40%/);
  });

  test('wind-down：含四點收尾指示與 resume_file 名稱', () => {
    const result = computeTier(snapshot([['five_hour', 86]]), config, NOW_MS);
    const text = injectionText(result, { ...config, resume_file: 'NOTES.md' }, NOW_MS);
    assert.match(text, /不要開始新的大型步驟/);
    assert.match(text, /commit/);
    assert.match(text, /NOTES\.md/);
    assert.match(text, /plan/);
  });

  test('wind-down：列出設定的 plan_files', () => {
    const result = computeTier(snapshot([['five_hour', 86]]), config, NOW_MS);
    const text = injectionText(result, { ...config, plan_files: ['tasks/todo.md'] }, NOW_MS);
    assert.match(text, /tasks\/todo\.md/);
  });
});
