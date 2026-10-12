import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../scripts/cli.mjs';
import { ROOT, isolatedEnv, runHook, tempDir } from '../test-support/helpers.mjs';

const inHours = (h) => Math.floor(Date.now() / 1000) + h * 3600;

function withFake(pct, dir = tempDir()) {
  writeFileSync(
    join(dir, 'fake-usage.json'),
    JSON.stringify({ five_hour: { utilization: pct, resets_at: inHours(2) }, seven_day: { utilization: 38, resets_at: inHours(50) } }),
  );
  return dir;
}

const cli = (dir, ...args) => runCli(args, { env: isolatedEnv({ USAGE_SENTINEL_DIR: dir }) });
const savedConfig = (dir) => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));

describe('status', () => {
  test('顯示各視窗百分比、重置倒數、分段與資料來源，fake 資料標示 FAKE', async () => {
    const { code, text } = await cli(withFake(80), 'status');
    assert.equal(code, 0);
    assert.match(text, /FAKE/);
    assert.match(text, /5 小時：80%（\d+ 小時 \d+ 分後重置） · 分段 warn/);
    assert.match(text, /7 天：38%/);
    assert.match(text, /資料來源：fake/);
  });

  test('資料不可用時顯示原因', async () => {
    const { text } = await cli(tempDir(), 'status');
    assert.match(text, /不可用原因：憑證無效/);
  });

  test('429 退避中時顯示剩餘秒數（驗收 8）', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'poll.json'), JSON.stringify({ backoff_until: inHours(0) + 120, status: { code: 'rate_limited' } }));
    const { text } = await cli(dir, 'status');
    assert.match(text, /429 退避中（剩 1[12]\d 秒）/);
  });

  test('DISABLED 存在時顯示已停用', async () => {
    const dir = withFake(10);
    writeFileSync(join(dir, 'DISABLED'), '');
    assert.match((await cli(dir, 'status')).text, /已停用（DISABLED 檔案存在）/);
  });

  test('off 之後顯示已關閉', async () => {
    const dir = withFake(10);
    await cli(dir, 'off');
    assert.match((await cli(dir, 'status')).text, /守衛：已關閉/);
  });

  test('設定檔不合法時顯示錯誤', async () => {
    const dir = withFake(10);
    writeFileSync(join(dir, 'config.json'), '{"snooze_step": 99}');
    assert.match((await cli(dir, 'status')).text, /設定錯誤.*snooze_step/);
  });

  test('狀態資料夾不存在時不建立，並提示尚未初始化', async () => {
    const dir = join(tempDir(), 'missing');
    const { text } = await cli(dir, 'status');
    assert.match(text, /尚未初始化/);
    assert.equal(existsSync(dir), false);
  });

  test('沒有子指令時預設為 status', async () => {
    assert.match((await cli(withFake(10))).text, /5 小時：10%/);
  });
});

describe('on／off', () => {
  test('off 之後 hook 直接放行，on 之後恢復', async () => {
    const dir = withFake(80);
    assert.equal((await cli(dir, 'off')).code, 0);
    assert.equal(savedConfig(dir).enabled, false);
    const env = { USAGE_SENTINEL_DIR: dir };
    assert.equal(runHook('guard.mjs', { input: { session_id: 's' }, env }).stdout, '');
    await cli(dir, 'on');
    assert.equal(savedConfig(dir).enabled, true);
    assert.notEqual(runHook('guard.mjs', { input: { session_id: 's' }, env }).stdout, '');
  });

  test('使用者執行的指令可以建立狀態資料夾（FR-7）', async () => {
    const dir = join(tempDir(), 'missing');
    await cli(dir, 'on');
    assert.equal(savedConfig(dir).enabled, true);
  });
});

describe('set', () => {
  test('修改巢狀鍵並保留其他設定', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ snooze_step: 5 }));
    const { code } = await cli(dir, 'set', 'thresholds.stop', '95');
    assert.equal(code, 0);
    assert.deepEqual(savedConfig(dir), { snooze_step: 5, thresholds: { stop: 95 } });
  });

  test('陣列、null、布林值以 JSON 解析', async () => {
    const dir = tempDir();
    await cli(dir, 'set', 'plan_files', '["tasks/todo.md"]');
    await cli(dir, 'set', 'notify.desktop', 'false');
    await cli(dir, 'set', 'notify.webhook_url', 'null');
    assert.deepEqual(savedConfig(dir), { plan_files: ['tasks/todo.md'], notify: { desktop: false, webhook_url: null } });
  });

  test('字串值不需要加引號', async () => {
    const dir = tempDir();
    await cli(dir, 'set', 'resume_file', 'NOTES.md');
    assert.equal(savedConfig(dir).resume_file, 'NOTES.md');
  });

  const invalid = [
    ['門檻順序錯誤', 'thresholds.stop', '99', /warn < wind_down < stop < 99/],
    ['prompt_timeout_seconds 超過 110', 'prompt_timeout_seconds', '111', /prompt_timeout_seconds/],
    ['型別錯誤', 'snooze_step', 'abc', /snooze_step/],
    ['未知的鍵', 'nonsense', '1', /未知的設定/],
    ['不可由 set 修改的鍵', 'chain_statusline', '"x"', /未知的設定/],
  ];
  for (const [label, key, value, message] of invalid) {
    test(`拒絕：${label}，且不改動設定檔`, async () => {
      const dir = tempDir();
      writeFileSync(join(dir, 'config.json'), '{"snooze_step":5}');
      const { code, text } = await cli(dir, 'set', key, value);
      assert.equal(code, 1);
      assert.match(text, message);
      assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), '{"snooze_step":5}');
    });
  }

  test('缺少參數時回報用法', async () => {
    const { code, text } = await cli(tempDir(), 'set', 'snooze_step');
    assert.equal(code, 1);
    assert.match(text, /用法/);
  });
});

describe('test-dialog', () => {
  const run = (dir, dialog) => runCli(['test-dialog'], { env: isolatedEnv({ USAGE_SENTINEL_DIR: dir }), dialog });

  test('用假資料跳出 5 小時視窗的對話框，逾時取自設定，標示 FAKE', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ prompt_timeout_seconds: 30 }));
    let spec;
    await run(dir, async (s) => {
      spec = s;
      return { choice: 'stop', elapsedMs: 10 };
    });
    assert.match(spec.title, /FAKE/);
    assert.match(spec.body, /5 小時用量 93%/);
    assert.deepEqual(spec.buttons.map((b) => b.id), ['continue', 'until_reset', 'stop']);
    assert.equal(spec.timeoutSeconds, 30);
  });

  const outcomes = [
    ['continue', /選擇：繼續/],
    ['until_reset', /選擇：到重置前不再問/],
    ['stop', /選擇：停止/],
    ['timeout', /逾時（視為停止）/],
    ['dismissed', /關閉視窗（視為停止）/],
    ['unavailable', /對話框不可用/],
  ];
  for (const [choice, expected] of outcomes) {
    test(`回報結果：${choice}`, async () => {
      const { code, text } = await run(tempDir(), async () => ({ choice, elapsedMs: 3210 }));
      assert.equal(code, 0);
      assert.match(text, expected);
      assert.match(text, /耗時 3\.2 秒/);
    });
  }

  test('對話框不可用時印出原因', async () => {
    const { text } = await run(tempDir(), async () => ({ choice: 'unavailable', elapsedMs: 400, detail: 'exit 1：Exception setting "ActiveControl"' }));
    assert.match(text, /原因：exit 1：Exception setting "ActiveControl"/);
  });

  test('不寫入任何決策或狀態檔', async () => {
    const dir = tempDir();
    await run(dir, async () => ({ choice: 'continue', elapsedMs: 1 }));
    assert.equal(existsSync(join(dir, 'decision.json')), false);
    assert.equal(existsSync(join(dir, 'snooze.json')), false);
  });
});

test('未知的子指令回報用法', async () => {
  const { code, text } = await cli(tempDir(), 'bogus');
  assert.equal(code, 1);
  assert.match(text, /用法/);
});

describe('commands/usage-sentinel.md', () => {
  const md = readFileSync(join(ROOT, 'commands', 'usage-sentinel.md'), 'utf8');

  test('禁止 agent 自行叫用（FR-6）', () => {
    assert.match(md, /^disable-model-invocation: true$/m);
  });

  test('以使用者的參數呼叫 cli.mjs', () => {
    assert.match(md, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/cli\.mjs" \$ARGUMENTS/);
  });
});
