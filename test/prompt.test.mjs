import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHook, tempDir } from '../test-support/helpers.mjs';

const inHours = (h) => Math.floor(Date.now() / 1000) + h * 3600;

function withFake(pct) {
  const dir = tempDir();
  writeFileSync(join(dir, 'fake-usage.json'), JSON.stringify({ five_hour: { utilization: pct, resets_at: inHours(2) } }));
  return dir;
}

function call(script, dir, input = {}) {
  const result = runHook(script, {
    input: { session_id: 'session-a', prompt: 'hi', tool_name: 'Read', tool_input: {}, ...input },
    env: { USAGE_SENTINEL_DIR: dir },
  });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

describe('prompt.mjs（UserPromptSubmit）', () => {
  test('warn 分段注入用量，事件名稱為 UserPromptSubmit', () => {
    const output = call('prompt.mjs', withFake(80));
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(output.hookSpecificOutput.additionalContext, /5 小時用量 80%/);
  });

  test('與 PreToolUse 共用「已注入」紀錄', () => {
    const dir = withFake(80);
    assert.ok(call('prompt.mjs', dir));
    assert.equal(call('guard.mjs', dir), null);
  });

  test('normal 分段不輸出', () => {
    assert.equal(call('prompt.mjs', withFake(10)), null);
  });
});

describe('資料不可用時的注入（FR-3）', () => {
  test('沒有資料：注入不可用原因，每個 session 只注入一次', () => {
    const dir = tempDir(); // 沒有 fake、沒有 credentials
    const first = call('guard.mjs', dir);
    assert.match(first.hookSpecificOutput.additionalContext, /用量資料不可用：憑證無效/);
    assert.equal(first.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(call('guard.mjs', dir), null);
    assert.equal(call('prompt.mjs', dir), null);
  });

  test('資料過期：注入不可用，不依過期資料判斷分段', () => {
    const dir = tempDir();
    const old = Math.floor(Date.now() / 1000) - 3600;
    writeFileSync(
      join(dir, 'cache.json'),
      JSON.stringify({ windows: { five_hour: { window: 'five_hour', pct: 95, resets_at: inHours(2), observed_at: old, source: 'endpoint' } } }),
    );
    // 讓輪詢處於退避期，不發請求
    writeFileSync(join(dir, 'poll.json'), JSON.stringify({ backoff_until: inHours(1), status: { code: 'rate_limited' } }));
    const output = call('guard.mjs', dir);
    assert.match(output.hookSpecificOutput.additionalContext, /用量資料不可用：429 退避中.*資料已過期 60 分鐘/);
  });

  test('subagent 不注入不可用訊息', () => {
    assert.equal(call('guard.mjs', tempDir(), { agent_id: 'a1' }), null);
  });
});
