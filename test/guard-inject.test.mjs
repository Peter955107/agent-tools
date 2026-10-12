import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, runHook, tempDir } from '../test-support/helpers.mjs';

const inHours = (h) => Math.floor(Date.now() / 1000) + h * 3600;

function setup({ fiveHour, sevenDay = 10, resetsAt = inHours(2), config } = {}) {
  const dir = tempDir();
  const fake = { five_hour: { utilization: fiveHour, resets_at: resetsAt } };
  if (sevenDay !== null) fake.seven_day = { utilization: sevenDay, resets_at: inHours(72) };
  writeFileSync(join(dir, 'fake-usage.json'), JSON.stringify(fake));
  if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

function setFiveHour(dir, pct) {
  writeFileSync(join(dir, 'fake-usage.json'), JSON.stringify({ five_hour: { utilization: pct, resets_at: inHours(2) } }));
}

function callGuard(dir, input = {}) {
  const result = runHook('guard.mjs', {
    input: { session_id: 'session-a', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x' }, ...input },
    env: { USAGE_SENTINEL_DIR: dir },
  });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

describe('guard.mjs 注入', () => {
  test('normal 分段不輸出', () => {
    assert.equal(callGuard(setup({ fiveHour: 50 })), null);
  });

  test('warn 分段以 additionalContext 注入用量，不輸出任何權限決策', () => {
    const output = callGuard(setup({ fiveHour: 80 }));
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(output.hookSpecificOutput.additionalContext, /5 小時用量 80%/);
    assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(output.continue, undefined);
  });

  test('同一 session 同一分段只注入一次', () => {
    const dir = setup({ fiveHour: 80 });
    assert.ok(callGuard(dir));
    assert.equal(callGuard(dir), null);
  });

  test('不同 session 各自注入', () => {
    const dir = setup({ fiveHour: 80 });
    assert.ok(callGuard(dir, { session_id: 'session-a' }));
    assert.ok(callGuard(dir, { session_id: 'session-b' }));
  });

  test('分段升級到 wind-down 時再注入收尾指示', () => {
    const dir = setup({ fiveHour: 80 });
    callGuard(dir);
    setFiveHour(dir, 86);
    const output = callGuard(dir);
    assert.match(output.hookSpecificOutput.additionalContext, /RESUME\.md/);
    assert.equal(callGuard(dir), null);
  });

  test('subagent 的呼叫不注入，也不佔用主 agent 的注入機會', () => {
    const dir = setup({ fiveHour: 80 });
    assert.equal(callGuard(dir, { agent_id: 'agent-1', agent_type: 'Explore' }), null);
    assert.ok(callGuard(dir));
  });

  test('enabled=false 時不輸出', () => {
    assert.equal(callGuard(setup({ fiveHour: 80, config: { enabled: false } })), null);
  });

  test('重置時間已過的視窗視為 0%，不注入', () => {
    assert.equal(callGuard(setup({ fiveHour: 95, resetsAt: inHours(-1) })), null);
  });

  test('DISABLED 存在時用量 93% 也不注入（驗收 15）', () => {
    const dir = setup({ fiveHour: 93 });
    writeFileSync(join(dir, 'DISABLED'), '');
    assert.equal(callGuard(dir), null);
  });

  test('同一則訊息裡平行的工具呼叫只注入一次（A7）', async () => {
    const dir = setup({ fiveHour: 80 });
    const input = JSON.stringify({ session_id: 'session-a', tool_name: 'Read', tool_input: {} });
    const outputs = await Promise.all(
      Array.from({ length: 6 }, () =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [join(ROOT, 'scripts', 'guard.mjs')], {
            env: { ...process.env, USAGE_SENTINEL_DIR: dir },
          });
          let out = '';
          child.stdout.on('data', (d) => (out += d));
          child.on('error', reject);
          child.on('close', () => resolve(out));
          child.stdin.end(input);
        }),
      ),
    );
    assert.equal(outputs.filter((o) => o !== '').length, 1);
  });

  test('handler 丟出例外時 fail-open：exit 0、不輸出，並寫入 errors.log', () => {
    const dir = setup({ fiveHour: 80 });
    writeFileSync(join(dir, 'injected'), 'not a directory');
    assert.equal(callGuard(dir), null);
    const log = readFileSync(join(dir, 'errors.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.length, 1);
    assert.equal(log[0].hook, 'PreToolUse');
  });

  test('fake-usage.json 壞掉時 fail-open：exit 0、不輸出', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'fake-usage.json'), '{ broken');
    assert.equal(callGuard(dir), null);
  });
});
