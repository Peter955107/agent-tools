import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHook, tempDir } from '../test-support/helpers.mjs';

const now = () => Math.floor(Date.now() / 1000);
const RESET = now() + 2 * 3600;

function setup(pct = 93) {
  const dir = tempDir();
  writeFileSync(join(dir, 'fake-usage.json'), JSON.stringify({ five_hour: { utilization: pct, resets_at: RESET } }));
  return dir;
}

function hook(script, dir, input = {}, env = {}) {
  const result = runHook(script, {
    input: { session_id: 'session-a', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_1', ...input },
    env: { USAGE_SENTINEL_DIR: dir, USAGE_SENTINEL_DIALOG_STUB: 'unavailable', ...env },
  });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : {};
}

const readJson = (dir, name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const events = (dir) =>
  existsSync(join(dir, 'events.log')) ? readFileSync(join(dir, 'events.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
const decisionOf = (output) => output.hookSpecificOutput?.permissionDecision;

describe('對話框不可用時改用 ask（FR-4.3 第 2 項）', () => {
  test('輸出 ask 並附上說明，記錄待決的 tool_use_id', () => {
    const dir = setup();
    const output = hook('guard.mjs', dir);
    assert.equal(decisionOf(output), 'ask');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /5 小時用量 93%.*核准＝繼續.*拒絕＝停止/);
    assert.deepEqual(readJson(dir, 'pending-ask.json').tool_use_ids, ['toolu_1']);
    assert.equal(existsSync(join(dir, 'stopped.json')), false);
    assert.equal(existsSync(join(dir, 'snooze.json')), false);
  });

  test('同一個 tool_use_id 觸發 PostToolUse ＝ 使用者核准 ＝ 繼續', () => {
    const dir = setup();
    hook('guard.mjs', dir);
    hook('post.mjs', dir, { tool_response: { stdout: '' } });
    assert.equal(readJson(dir, 'snooze.json').five_hour.limit_pct, 97);
    assert.equal(existsSync(join(dir, 'pending-ask.json')), false);
    const [event] = events(dir);
    assert.equal(event.method, 'ask');
    assert.equal(event.choice, 'continue');
    assert.equal(decisionOf(hook('guard.mjs', dir, { tool_use_id: 'toolu_2' })), undefined);
  });

  test('其他 tool_use_id 的 PostToolUse 不算核准', () => {
    const dir = setup();
    hook('guard.mjs', dir);
    hook('post.mjs', dir, { tool_use_id: 'toolu_other' });
    assert.equal(existsSync(join(dir, 'snooze.json')), false);
    assert.ok(existsSync(join(dir, 'pending-ask.json')));
  });

  test('同一批平行呼叫（5 秒內）也輸出 ask，核准其中任何一個都算繼續', () => {
    const dir = setup();
    hook('guard.mjs', dir);
    assert.equal(decisionOf(hook('guard.mjs', dir, { tool_use_id: 'toolu_2' })), 'ask');
    assert.deepEqual(readJson(dir, 'pending-ask.json').tool_use_ids, ['toolu_1', 'toolu_2']);
    hook('post.mjs', dir, { tool_use_id: 'toolu_2' });
    assert.equal(readJson(dir, 'snooze.json').five_hour.limit_pct, 97);
  });

  test('超過 5 秒沒有核准，下一次呼叫視為拒絕 ＝ 停止', () => {
    const dir = setup();
    hook('guard.mjs', dir);
    const pending = readJson(dir, 'pending-ask.json');
    writeFileSync(join(dir, 'pending-ask.json'), JSON.stringify({ ...pending, at: Date.now() - 6000 }));
    const output = hook('guard.mjs', dir, { tool_use_id: 'toolu_2' });
    assert.equal(decisionOf(output), 'deny');
    assert.equal(readJson(dir, 'stopped.json').reason, 'user');
    assert.equal(existsSync(join(dir, 'pending-ask.json')), false);
    const [event] = events(dir);
    assert.equal(event.method, 'ask');
    assert.equal(event.choice, 'stop');
  });

  test('無人值守時不 ask，直接停止', () => {
    const dir = setup();
    const output = hook('guard.mjs', dir, {}, { CLAUDE_CODE_SESSION_ATTENDED: '0' });
    assert.equal(decisionOf(output), 'deny');
    assert.equal(existsSync(join(dir, 'pending-ask.json')), false);
  });

  test('取不到 CLAUDE_CODE_SESSION_ATTENDED 時視為有人值守', () => {
    assert.equal(decisionOf(hook('guard.mjs', setup())), 'ask');
  });
});
