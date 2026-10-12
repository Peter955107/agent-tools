import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../scripts/state.mjs';
import { activeStop, isSnoozeValid, promptTarget, snoozeEntry, waitForOutcome } from '../scripts/decision.mjs';
import { computeTier } from '../scripts/tiers.mjs';
import { tempDir } from '../test-support/helpers.mjs';

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const RESET = NOW + 3600;
const config = structuredClone(DEFAULT_CONFIG);

const win = (pct, window = 'five_hour', resets_at = RESET) => ({ window, pct, resets_at });

function result(...windows) {
  const snapshot = { source: 'endpoint', observed_at: NOW, windows: {} };
  for (const w of windows) snapshot.windows[w.window] = { ...w, observed_at: NOW, source: 'endpoint' };
  return computeTier(snapshot, config, NOW_MS);
}

describe('snoozeEntry', () => {
  test('繼續：上限為按下時的百分比 + snooze_step', () => {
    assert.deepEqual(snoozeEntry('continue', win(93), config, NOW), {
      window: 'five_hour',
      asked_pct: 93,
      limit_pct: 97,
      until_reset: false,
      resets_at: RESET,
      set_at: NOW,
    });
  });

  test('到重置前不再問：不設上限', () => {
    const entry = snoozeEntry('until_reset', win(93), config, NOW);
    assert.equal(entry.until_reset, true);
    assert.equal(entry.limit_pct, null);
  });
});

describe('isSnoozeValid', () => {
  test('未達上限時有效', () => {
    assert.equal(isSnoozeValid(snoozeEntry('continue', win(93), config, NOW), win(96.9)), true);
  });

  test('達到上限時失效（按 93% 繼續，97% 再問）', () => {
    assert.equal(isSnoozeValid(snoozeEntry('continue', win(93), config, NOW), win(97)), false);
  });

  test('到重置前不再問：98% 仍有效', () => {
    assert.equal(isSnoozeValid(snoozeEntry('until_reset', win(93), config, NOW), win(98)), true);
  });

  test('99% 覆蓋任何在 99% 以下取得的 snooze', () => {
    assert.equal(isSnoozeValid(snoozeEntry('until_reset', win(93), config, NOW), win(99)), false);
  });

  test('在 99% 以上按的繼續不會被 99% 規則反覆覆蓋', () => {
    assert.equal(isSnoozeValid(snoozeEntry('continue', win(99), config, NOW), win(99.5)), true);
  });

  test('不同重置週期的 snooze 失效', () => {
    assert.equal(isSnoozeValid(snoozeEntry('until_reset', win(93), config, NOW), win(93, 'five_hour', RESET + 18_000)), false);
  });

  test('重置時間只差小數秒仍視為同一週期', () => {
    assert.equal(isSnoozeValid(snoozeEntry('continue', win(93), config, NOW), win(94, 'five_hour', RESET + 0.4)), true);
  });

  test('沒有 snooze 時無效', () => {
    assert.equal(isSnoozeValid(undefined, win(93)), false);
  });
});

describe('promptTarget', () => {
  test('低於停止門檻時不詢問', () => {
    assert.equal(promptTarget(result(win(91.9)), {}), null);
  });

  test('達到停止門檻且沒有 snooze 時詢問該視窗', () => {
    assert.equal(promptTarget(result(win(92)), {}).window, 'five_hour');
  });

  test('有效的 snooze 時不詢問', () => {
    const snoozes = { five_hour: snoozeEntry('continue', win(93), config, NOW) };
    assert.equal(promptTarget(result(win(95)), snoozes), null);
  });

  test('一個視窗 snooze 中，另一個視窗達到門檻時詢問另一個', () => {
    const snoozes = { five_hour: snoozeEntry('until_reset', win(93), config, NOW) };
    const target = promptTarget(result(win(95), win(92, 'seven_day', NOW + 86400)), snoozes);
    assert.equal(target.window, 'seven_day');
  });

  test('兩個視窗都需要詢問時，先問百分比高的', () => {
    assert.equal(promptTarget(result(win(93), win(96, 'seven_day', NOW + 86400)), {}).window, 'seven_day');
  });
});

describe('activeStop', () => {
  test('沒有 stopped.json 時回傳 null', () => {
    assert.equal(activeStop(tempDir(), NOW_MS), null);
  });

  test('觸發視窗重置前有效', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'stopped.json'), JSON.stringify({ window: 'five_hour', pct: 93, resets_at: RESET }));
    assert.equal(activeStop(dir, NOW_MS).pct, 93);
  });

  test('觸發視窗重置後失效', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'stopped.json'), JSON.stringify({ window: 'five_hour', pct: 93, resets_at: NOW - 1 }));
    assert.equal(activeStop(dir, NOW_MS), null);
  });
});

describe('waitForOutcome（沒搶到 prompt.lock 的呼叫）', () => {
  test('等到別人寫入的結果就返回', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'prompt.lock')); // 別人正拿著鎖
    let calls = 0;
    const outcome = await waitForOutcome({
      check: () => (++calls >= 3 ? { kind: 'continue' } : null),
      lockPath: join(dir, 'prompt.lock'),
      maxWaitMs: 5000,
      intervalMs: 10,
    });
    assert.deepEqual(outcome, { kind: 'continue' });
  });

  test('鎖消失但沒有結果時回傳 retry，讓呼叫者重新判斷', async () => {
    const dir = tempDir();
    const outcome = await waitForOutcome({ check: () => null, lockPath: join(dir, 'prompt.lock'), maxWaitMs: 5000, intervalMs: 10 });
    assert.deepEqual(outcome, { kind: 'retry' });
  });

  test('等太久視為停止', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'prompt.lock'));
    const outcome = await waitForOutcome({ check: () => null, lockPath: join(dir, 'prompt.lock'), maxWaitMs: 100, intervalMs: 10 });
    assert.deepEqual(outcome, { kind: 'stop', reason: 'wait_timeout' });
  });
});
