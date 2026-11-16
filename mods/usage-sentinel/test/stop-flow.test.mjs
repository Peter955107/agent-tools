import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, isolatedEnv, runHook, tempDir } from '../test-support/helpers.mjs';

const now = () => Math.floor(Date.now() / 1000);
const RESET = now() + 2 * 3600;

function setFake(dir, fiveHour, sevenDay = 10) {
  writeFileSync(
    join(dir, 'fake-usage.json'),
    JSON.stringify({ five_hour: { utilization: fiveHour, resets_at: RESET }, seven_day: { utilization: sevenDay, resets_at: now() + 3 * 86400 } }),
  );
}

function setup(fiveHour, sevenDay) {
  const dir = tempDir();
  setFake(dir, fiveHour, sevenDay);
  return dir;
}

// USAGE_SENTINEL_DIALOG_STUB：測試用的對話框替身，格式為「選擇[:延遲毫秒]」。
function guard(dir, { stub = 'continue', input = {}, env = {} } = {}) {
  const result = runHook('guard.mjs', {
    input: { session_id: 'session-a', tool_name: 'Bash', tool_input: { command: 'ls' }, ...input },
    env: { USAGE_SENTINEL_DIR: dir, USAGE_SENTINEL_DIALOG_STUB: stub, ...env },
  });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : {};
}

const events = (dir) =>
  existsSync(join(dir, 'events.log'))
    ? readFileSync(join(dir, 'events.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : [];
const readState = (dir, name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const decisionOf = (output) => output.hookSpecificOutput?.permissionDecision;

describe('達到停止門檻時詢問（驗收 1）', () => {
  test('低於門檻時不詢問', () => {
    const dir = setup(91);
    guard(dir);
    assert.equal(events(dir).length, 0);
  });

  test('93% 時跳出對話框，並記錄到 events.log', () => {
    const dir = setup(93);
    guard(dir);
    const [event] = events(dir);
    assert.equal(event.window, 'five_hour');
    assert.equal(event.pct, 93);
    assert.equal(event.method, 'dialog');
    assert.equal(event.choice, 'continue');
    assert.equal(event.timed_out, false);
    assert.equal(event.source, 'fake');
    assert.equal(typeof event.data_age_seconds, 'number');
    assert.equal(event.session, 'session-a');
  });
});

describe('選擇「繼續」（驗收 2）', () => {
  test('不輸出任何權限決策，讓一般權限流程照常運作', () => {
    const output = guard(setup(93));
    assert.equal(decisionOf(output), undefined);
    assert.equal(output.continue, undefined);
  });

  test('寫入 snooze 與 decision.json', () => {
    const dir = setup(93);
    guard(dir);
    assert.equal(readState(dir, 'snooze.json').five_hour.limit_pct, 97);
    assert.equal(readState(dir, 'decision.json').choice, 'continue');
  });

  test('升到 97% 前不再詢問，97% 時再問', () => {
    const dir = setup(93);
    guard(dir);
    setFake(dir, 96);
    guard(dir);
    assert.equal(events(dir).length, 1);
    setFake(dir, 97);
    guard(dir);
    assert.equal(events(dir).length, 2);
  });

  test('到重置前不再問：98% 不問，99% 仍再問一次', () => {
    const dir = setup(93);
    guard(dir, { stub: 'until_reset' });
    setFake(dir, 98);
    guard(dir);
    assert.equal(events(dir).length, 1);
    setFake(dir, 99);
    guard(dir);
    assert.equal(events(dir).length, 2);
    guard(dir);
    assert.equal(events(dir).length, 2, '99% 按了繼續之後不應反覆詢問');
  });
});

describe('選擇「停止」', () => {
  test('擋下當次呼叫並說明原因', () => {
    const output = guard(setup(93), { stub: 'stop' });
    assert.equal(decisionOf(output), 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /usage-sentinel：用量 93%，使用者選擇停止/);
  });

  test('寫入已停止狀態，之後的呼叫不再詢問、直接擋下', () => {
    const dir = setup(93);
    guard(dir, { stub: 'stop' });
    assert.equal(readState(dir, 'stopped.json').resets_at, RESET);
    const output = guard(dir, { stub: 'continue' });
    assert.equal(decisionOf(output), 'deny');
    assert.equal(events(dir).length, 1);
  });

  for (const [stub, label] of [['timeout', '逾時（驗收 5）'], ['dismissed', '關閉視窗']]) {
    test(`${label}視為停止`, () => {
      const dir = setup(93);
      assert.equal(decisionOf(guard(dir, { stub })), 'deny');
      const [event] = events(dir);
      assert.equal(event.choice, 'stop');
      assert.equal(event.timed_out, stub === 'timeout');
    });
  }

  test('已停止狀態在觸發視窗重置後失效', () => {
    const dir = setup(10);
    writeFileSync(join(dir, 'stopped.json'), JSON.stringify({ window: 'five_hour', pct: 93, resets_at: now() - 1 }));
    assert.equal(decisionOf(guard(dir)), undefined);
  });

  test('subagent 觸發停止，主 agent 下一次呼叫也被擋下（驗收 7）', () => {
    const dir = setup(93);
    assert.equal(decisionOf(guard(dir, { stub: 'stop', input: { agent_id: 'a1', agent_type: 'Explore' } })), 'deny');
    assert.equal(decisionOf(guard(dir)), 'deny');
  });
});

describe('無人值守（驗收 10）', () => {
  test('CLAUDE_CODE_SESSION_ATTENDED=0 時不詢問，直接停止', () => {
    const dir = setup(93);
    const output = guard(dir, { stub: 'continue', env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } });
    assert.equal(decisionOf(output), 'deny');
    assert.equal(events(dir)[0].method, 'unattended');
  });
});

describe('資料不可用時不阻擋（FR-3）', () => {
  test('資料過期的 95% 不詢問、不擋', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'cache.json'),
      JSON.stringify({ windows: { five_hour: { window: 'five_hour', pct: 95, resets_at: RESET, observed_at: now() - 3600, source: 'endpoint' } } }),
    );
    writeFileSync(join(dir, 'poll.json'), JSON.stringify({ backoff_until: now() + 300, status: { code: 'rate_limited' } }));
    assert.equal(decisionOf(guard(dir)), undefined);
    assert.equal(events(dir).length, 0);
  });
});

describe('同時觸發只出現一個對話框（驗收 6）', () => {
  function parallelGuards(dir, stub, count = 5) {
    const input = JSON.stringify({ session_id: 'session-a', tool_name: 'Read', tool_input: {} });
    return Promise.all(
      Array.from({ length: count }, (_, i) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [join(ROOT, 'scripts', 'guard.mjs')], {
            env: isolatedEnv({ USAGE_SENTINEL_DIR: dir, USAGE_SENTINEL_DIALOG_STUB: stub }),
          });
          let out = '';
          child.stdout.on('data', (d) => (out += d));
          child.on('error', reject);
          child.on('close', () => resolve(out ? JSON.parse(out) : {}));
          child.stdin.end(JSON.stringify({ ...JSON.parse(input), session_id: `session-${i % 2}` }));
        }),
      ),
    );
  }

  test('選繼續：只問一次，全部放行', async () => {
    const dir = setup(93);
    const outputs = await parallelGuards(dir, 'continue:1500');
    assert.equal(events(dir).length, 1);
    assert.ok(outputs.every((o) => decisionOf(o) === undefined));
  });

  test('選停止：只問一次，全部擋下', async () => {
    const dir = setup(93);
    const outputs = await parallelGuards(dir, 'stop:1500');
    assert.equal(events(dir).length, 1);
    assert.ok(outputs.every((o) => decisionOf(o) === 'deny'), JSON.stringify(outputs));
  });
});
