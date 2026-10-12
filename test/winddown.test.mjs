import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../scripts/cli.mjs';
import { isolatedEnv, runHook, tempDir } from '../test-support/helpers.mjs';

const now = () => Math.floor(Date.now() / 1000);
const RESET = now() + 2 * 3600;
const CWD = tempDir();

function setFake(dir, pct) {
  writeFileSync(join(dir, 'fake-usage.json'), JSON.stringify({ five_hour: { utilization: pct, resets_at: RESET } }));
}

function stoppedDir(extra = {}) {
  const dir = tempDir();
  setFake(dir, 93);
  writeFileSync(
    join(dir, 'stopped.json'),
    JSON.stringify({ window: 'five_hour', pct: 93, resets_at: RESET, reason: 'user', session: 's', at: now(), denials: 0, ...extra }),
  );
  return dir;
}

function hook(script, dir, input, env = {}) {
  const result = runHook(script, {
    input: { session_id: 'session-a', cwd: CWD, ...input },
    env: { USAGE_SENTINEL_DIR: dir, ...env },
  });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : {};
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const write = (name) => ({ tool_name: 'Write', tool_input: { file_path: join(CWD, name), content: 'x' } });
const decisionOf = (output) => output.hookSpecificOutput?.permissionDecision;
const stopped = (dir) => JSON.parse(readFileSync(join(dir, 'stopped.json'), 'utf8'));

describe('收尾模式（FR-4.6）', () => {
  test('允許清單內的呼叫不輸出決策，交給一般權限流程', () => {
    const dir = stoppedDir();
    assert.deepEqual(hook('guard.mjs', dir, bash('git commit -m wip')), {});
    assert.deepEqual(hook('guard.mjs', dir, write('RESUME.md')), {});
    assert.equal(stopped(dir).denials, 0);
  });

  test('第一次擋下：deny 並附收尾指示，不結束回合', () => {
    const output = hook('guard.mjs', stoppedDir(), bash('npm test'));
    assert.equal(decisionOf(output), 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /只允許 git add／git commit 與編輯 RESUME\.md/);
    assert.equal(output.continue, undefined);
  });

  test('第 stop_grace_denials 次擋下：deny + continue:false + stopReason', () => {
    const dir = stoppedDir();
    hook('guard.mjs', dir, bash('npm test'));
    hook('guard.mjs', dir, bash('npm test'));
    const output = hook('guard.mjs', dir, bash('npm test'));
    assert.equal(decisionOf(output), 'deny');
    assert.equal(output.continue, false);
    assert.equal(output.stopReason, 'usage-sentinel：已達 93% 用量，由使用者選擇停止');
  });

  test('stop_grace_denials 可設定', () => {
    const dir = stoppedDir();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ stop_grace_denials: 1 }));
    assert.equal(hook('guard.mjs', dir, bash('npm test')).continue, false);
  });

  test('收尾完成（commit 成功 + 寫入 resume_file）後，下一次非允許呼叫立即結束', () => {
    const dir = stoppedDir();
    hook('post.mjs', dir, { ...bash('git commit -m wip'), tool_response: { stdout: '[main abc1234] wip' } });
    assert.equal(hook('guard.mjs', dir, bash('npm test')).continue, undefined, '只有 commit 還不算完成');
    hook('post.mjs', dir, { ...write('RESUME.md'), tool_response: {} });
    const output = hook('guard.mjs', dir, bash('npm test'));
    assert.equal(output.continue, false);
  });

  test('commit 失敗（沒有摘要行）不算完成', () => {
    const dir = stoppedDir();
    hook('post.mjs', dir, { ...bash('git commit -m wip'), tool_response: { stdout: 'nothing to commit' } });
    hook('post.mjs', dir, { ...write('RESUME.md'), tool_response: {} });
    assert.equal(stopped(dir).committed, undefined);
  });

  test('視窗重新載入後接續的回合，第一次非允許呼叫就結束（驗收 4）', () => {
    const dir = stoppedDir({ denials: 3 });
    const output = hook('guard.mjs', dir, bash('npm test'));
    assert.equal(decisionOf(output), 'deny');
    assert.equal(output.continue, false);
  });

  test('逾時停止時 stopReason 說明原因', () => {
    const dir = stoppedDir({ reason: 'timeout', denials: 2 });
    assert.equal(hook('guard.mjs', dir, bash('npm test')).stopReason, 'usage-sentinel：已達 93% 用量，詢問逾時，自動停止');
  });

  test('選擇停止的那一次呼叫若在允許清單內，直接放行', () => {
    const dir = tempDir();
    setFake(dir, 93);
    const output = hook('guard.mjs', dir, bash('git commit -m wip'), { USAGE_SENTINEL_DIALOG_STUB: 'stop' });
    assert.equal(decisionOf(output), undefined);
    assert.ok(existsSync(join(dir, 'stopped.json')));
  });

  test('沒有停止時，PostToolUse 不寫任何狀態', () => {
    const dir = tempDir();
    hook('post.mjs', dir, { ...bash('git commit -m wip'), tool_response: { stdout: '[main abc1234] wip' } });
    assert.equal(existsSync(join(dir, 'stopped.json')), false);
  });
});

describe('/usage-sentinel resume／snooze', () => {
  const cli = (dir, ...args) => runCli(args, { env: isolatedEnv({ USAGE_SENTINEL_DIR: dir }) });

  test('resume 解除已停止狀態', async () => {
    const dir = stoppedDir();
    const { code, text } = await cli(dir, 'resume');
    assert.equal(code, 0);
    assert.match(text, /已解除/);
    assert.equal(existsSync(join(dir, 'stopped.json')), false);
  });

  test('沒有停止時 resume 說明目前未停止', async () => {
    assert.match((await cli(tempDir(), 'resume')).text, /目前沒有停止/);
  });

  test('snooze <分鐘>：期間內 93% 不詢問', async () => {
    const dir = tempDir();
    setFake(dir, 93);
    assert.equal((await cli(dir, 'snooze', '30')).code, 0);
    const output = hook('guard.mjs', dir, bash('ls'), { USAGE_SENTINEL_DIALOG_STUB: 'stop' });
    assert.equal(decisionOf(output), undefined);
    assert.equal(existsSync(join(dir, 'stopped.json')), false);
  });

  test('snooze 期間到 99% 仍會詢問', async () => {
    const dir = tempDir();
    setFake(dir, 99);
    await cli(dir, 'snooze', '30');
    assert.equal(decisionOf(hook('guard.mjs', dir, bash('ls'), { USAGE_SENTINEL_DIALOG_STUB: 'stop' })), 'deny');
  });

  test('snooze clear 清除所有 snooze', async () => {
    const dir = tempDir();
    setFake(dir, 93);
    await cli(dir, 'snooze', '30');
    await cli(dir, 'snooze', 'clear');
    assert.equal(decisionOf(hook('guard.mjs', dir, bash('ls'), { USAGE_SENTINEL_DIALOG_STUB: 'stop' })), 'deny');
  });

  for (const bad of ['0', '-5', 'abc', '100000']) {
    test(`snooze 拒絕不合理的值：${bad}`, async () => {
      assert.equal((await cli(tempDir(), 'snooze', bad)).code, 1);
    });
  }

  test('status 顯示 snooze 與已停止狀態', async () => {
    const dir = stoppedDir({ denials: 1 });
    await cli(dir, 'snooze', '30');
    const { text } = await cli(dir, 'status');
    assert.match(text, /snooze：手動，到 \d{2}:\d{2}/);
    assert.match(text, /已停止：是（5 小時 93%，使用者選擇停止），已擋下 1 次/);
  });

  test('status 在沒有停止時顯示「否」', async () => {
    const dir = tempDir();
    setFake(dir, 10);
    const { text } = await cli(dir, 'status');
    assert.match(text, /已停止：否/);
    assert.match(text, /snooze：無/);
  });
});
