import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync as renameReal, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  acquireLock,
  atomicWrite,
  loadConfig,
  releaseLock,
  validateConfig,
} from '../scripts/state.mjs';
import { ROOT, tempDir } from '../test-support/helpers.mjs';

function withConfig(patch) {
  return { ...structuredClone(DEFAULT_CONFIG), ...patch };
}

describe('validateConfig', () => {
  test('預設設定合法', () => {
    assert.deepEqual(validateConfig(structuredClone(DEFAULT_CONFIG)), []);
  });

  test('門檻必須 warn < wind_down < stop', () => {
    const errors = validateConfig(withConfig({ thresholds: { warn: 85, wind_down: 85, stop: 92 } }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /warn < wind_down < stop < 99/);
  });

  test('stop 必須小於 99', () => {
    assert.equal(validateConfig(withConfig({ thresholds: { warn: 75, wind_down: 85, stop: 99 } })).length, 1);
    assert.deepEqual(validateConfig(withConfig({ thresholds: { warn: 75, wind_down: 85, stop: 98 } })), []);
  });

  test('poll_interval_seconds 不得小於 60', () => {
    assert.equal(validateConfig(withConfig({ poll_interval_seconds: 59 })).length, 1);
    assert.deepEqual(validateConfig(withConfig({ poll_interval_seconds: 60 })), []);
  });

  test('poll_interval_seconds 不得大於 stale_after_seconds', () => {
    assert.equal(validateConfig(withConfig({ poll_interval_seconds: 700, stale_after_seconds: 600 })).length, 1);
  });

  test('prompt_timeout_seconds 介於 10 與 110', () => {
    assert.equal(validateConfig(withConfig({ prompt_timeout_seconds: 9 })).length, 1);
    assert.equal(validateConfig(withConfig({ prompt_timeout_seconds: 111 })).length, 1);
    assert.deepEqual(validateConfig(withConfig({ prompt_timeout_seconds: 110 })), []);
  });

  test('snooze_step 介於 1 與 10', () => {
    assert.equal(validateConfig(withConfig({ snooze_step: 0 })).length, 1);
    assert.equal(validateConfig(withConfig({ snooze_step: 11 })).length, 1);
  });

  test('windows 只能是 five_hour／seven_day，且不得為空', () => {
    assert.equal(validateConfig(withConfig({ windows: [] })).length, 1);
    assert.equal(validateConfig(withConfig({ windows: ['opus'] })).length, 1);
    assert.deepEqual(validateConfig(withConfig({ windows: ['five_hour'] })), []);
  });

  test('型別錯誤會被拒絕', () => {
    assert.equal(validateConfig(withConfig({ enabled: 'yes' })).length, 1);
    assert.equal(validateConfig(withConfig({ snooze_step: '4' })).length, 1);
    assert.equal(validateConfig(withConfig({ resume_file: '' })).length, 1);
    assert.equal(validateConfig(withConfig({ plan_files: 'plan.md' })).length, 1);
  });

  test('chain_statusline 接受 null、指令字串，或原本的 statusLine 物件', () => {
    assert.deepEqual(validateConfig(withConfig({ chain_statusline: 'bash -c x' })), []);
    assert.deepEqual(validateConfig(withConfig({ chain_statusline: { type: 'command', command: 'bash -c x', padding: 0 } })), []);
    assert.equal(validateConfig(withConfig({ chain_statusline: { type: 'command' } })).length, 1);
    assert.equal(validateConfig(withConfig({ chain_statusline: 5 })).length, 1);
  });

  test('webhook_url 只接受 null 或 http(s) URL', () => {
    assert.equal(validateConfig(withConfig({ notify: { desktop: true, webhook_url: 'ftp://x' } })).length, 1);
    assert.deepEqual(validateConfig(withConfig({ notify: { desktop: true, webhook_url: 'https://ntfy.sh/x' } })), []);
  });
});

describe('loadConfig', () => {
  test('沒有 config.json 時回傳預設值', () => {
    const { config, errors } = loadConfig(tempDir());
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.deepEqual(errors, []);
  });

  test('部分設定會與預設值合併（含巢狀的 thresholds）', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ thresholds: { stop: 95 }, snooze_step: 5 }));
    const { config, errors } = loadConfig(dir);
    assert.deepEqual(errors, []);
    assert.deepEqual(config.thresholds, { warn: 75, wind_down: 85, stop: 95 });
    assert.equal(config.snooze_step, 5);
    assert.equal(config.poll_interval_seconds, 120);
  });

  test('不合法的設定退回預設值並回報錯誤', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ snooze_step: 50 }));
    const { config, errors } = loadConfig(dir);
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.equal(errors.length, 1);
  });

  test('壞掉的 JSON 退回預設值並回報錯誤', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'config.json'), '{ not json');
    const { config, errors } = loadConfig(dir);
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.equal(errors.length, 1);
  });
});

describe('atomicWrite', () => {
  test('寫入內容並且不留暫存檔', () => {
    const dir = tempDir();
    const path = join(dir, 'cache.json');
    assert.equal(atomicWrite(path, '{"a":1}'), true);
    assert.equal(readFileSync(path, 'utf8'), '{"a":1}');
    assert.deepEqual(readdirSync(dir), ['cache.json']);
  });

  test('rename 遇到 EPERM 會重試，之後成功', () => {
    const dir = tempDir();
    const path = join(dir, 'cache.json');
    let calls = 0;
    const flakyRename = (from, to) => {
      calls += 1;
      if (calls <= 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      return renameReal(from, to);
    };
    assert.equal(atomicWrite(path, 'x', { rename: flakyRename, sleep: () => {} }), true);
    assert.equal(calls, 4);
    assert.equal(readFileSync(path, 'utf8'), 'x');
  });

  test('重試 5 次仍失敗就回傳 false、不丟例外、清掉暫存檔', () => {
    const dir = tempDir();
    const path = join(dir, 'cache.json');
    const delays = [];
    let calls = 0;
    const alwaysBusy = () => {
      calls += 1;
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    };
    const result = atomicWrite(path, 'x', { rename: alwaysBusy, sleep: (ms) => delays.push(ms) });
    assert.equal(result, false);
    assert.equal(calls, 6); // 第一次 + 重試 5 次
    assert.equal(delays.length, 5);
    assert.ok(delays.every((ms) => ms >= 20 && ms <= 50), `間隔應在 20–50ms：${delays}`);
    assert.deepEqual(readdirSync(dir), []);
  });

  test('非 EPERM／EBUSY 的錯誤不重試', () => {
    const dir = tempDir();
    let calls = 0;
    const fail = () => {
      calls += 1;
      throw Object.assign(new Error('nope'), { code: 'EACCES' });
    };
    assert.equal(atomicWrite(join(dir, 'a.json'), 'x', { rename: fail, sleep: () => {} }), false);
    assert.equal(calls, 1);
  });
});

describe('acquireLock／releaseLock', () => {
  test('第一次取得成功，第二次立即失敗', () => {
    const dir = tempDir();
    const token = acquireLock(dir, 'poll.lock', { ttlSeconds: 60 });
    assert.ok(token);
    assert.equal(acquireLock(dir, 'poll.lock', { ttlSeconds: 60 }), null);
  });

  test('鎖內記錄 PID 與時間', () => {
    const dir = tempDir();
    acquireLock(dir, 'poll.lock', { ttlSeconds: 60 });
    const owner = JSON.parse(readFileSync(join(dir, 'poll.lock', 'owner.json'), 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.equal(typeof owner.at, 'number');
  });

  test('釋放後可再次取得', () => {
    const dir = tempDir();
    const token = acquireLock(dir, 'poll.lock', { ttlSeconds: 60 });
    releaseLock(dir, 'poll.lock', token);
    assert.equal(existsSync(join(dir, 'poll.lock')), false);
    assert.ok(acquireLock(dir, 'poll.lock', { ttlSeconds: 60 }));
  });

  test('token 不符時不釋放別人的鎖', () => {
    const dir = tempDir();
    acquireLock(dir, 'poll.lock', { ttlSeconds: 60 });
    releaseLock(dir, 'poll.lock', 'someone-else');
    assert.equal(existsSync(join(dir, 'poll.lock')), true);
  });

  test('超過 TTL 的死鎖會被回收', () => {
    const dir = tempDir();
    const start = Date.now();
    acquireLock(dir, 'prompt.lock', { ttlSeconds: 150, now: () => start });
    const later = () => start + 151_000;
    assert.ok(acquireLock(dir, 'prompt.lock', { ttlSeconds: 150, now: later }));
  });

  test('未超過 TTL 不回收', () => {
    const dir = tempDir();
    const start = Date.now();
    acquireLock(dir, 'prompt.lock', { ttlSeconds: 150, now: () => start });
    assert.equal(acquireLock(dir, 'prompt.lock', { ttlSeconds: 150, now: () => start + 149_000 }), null);
  });

  test('沒有 owner.json 的鎖依資料夾修改時間判斷死鎖', () => {
    const dir = tempDir();
    const lockPath = join(dir, 'poll.lock');
    mkdirSync(lockPath);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lockPath, old, old);
    assert.ok(acquireLock(dir, 'poll.lock', { ttlSeconds: 60 }));
  });

  test('多個程序同時搶鎖，恰好一個成功', async () => {
    const dir = tempDir();
    const worker = join(ROOT, 'test-support', 'lock-worker.mjs');
    const startAt = Date.now() + 500; // 讓所有程序同時起跑
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [worker, dir, String(startAt)]);
          let out = '';
          child.stdout.on('data', (d) => (out += d));
          child.on('error', reject);
          child.on('close', () => resolve(out.trim()));
        }),
      ),
    );
    assert.equal(results.filter((r) => r === 'won').length, 1, results.join(','));
    assert.equal(results.filter((r) => r === 'lost').length, 9, results.join(','));
  });
});
