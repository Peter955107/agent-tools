import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shouldRun, stateDir } from '../scripts/gate.mjs';
import { ROOT, runHook, tempDir } from '../test-support/helpers.mjs';

describe('gate.stateDir', () => {
  test('預設為 ~/.claude/usage-sentinel', () => {
    const dir = stateDir({}, () => '/home/u');
    assert.equal(dir, join('/home/u', '.claude', 'usage-sentinel'));
  });

  test('USAGE_SENTINEL_DIR 可覆寫狀態資料夾', () => {
    assert.equal(stateDir({ USAGE_SENTINEL_DIR: '/tmp/x' }), '/tmp/x');
  });
});

describe('gate.shouldRun', () => {
  test('資料夾存在且未停用時執行', () => {
    const dir = tempDir();
    assert.equal(shouldRun({ env: { USAGE_SENTINEL_DIR: dir } }), true);
  });

  test('資料夾不存在時不執行', () => {
    const dir = join(tempDir(), 'missing');
    assert.equal(shouldRun({ env: { USAGE_SENTINEL_DIR: dir } }), false);
  });

  test('資料夾不存在但允許時（SessionStart）仍執行', () => {
    const dir = join(tempDir(), 'missing');
    assert.equal(shouldRun({ env: { USAGE_SENTINEL_DIR: dir }, allowMissingDir: true }), true);
  });

  test('DISABLED 檔案存在時不執行', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'DISABLED'), '');
    assert.equal(shouldRun({ env: { USAGE_SENTINEL_DIR: dir }, allowMissingDir: true }), false);
  });

  test('USAGE_SENTINEL_DISABLE=1 時不執行', () => {
    const dir = tempDir();
    const env = { USAGE_SENTINEL_DIR: dir, USAGE_SENTINEL_DISABLE: '1' };
    assert.equal(shouldRun({ env, allowMissingDir: true }), false);
  });
});

describe('非 SessionStart 的 hook 在狀態資料夾不存在時', () => {
  for (const script of ['guard.mjs', 'post.mjs', 'prompt.mjs']) {
    test(`${script} exit 0、無輸出、不建立資料夾`, () => {
      const dir = join(tempDir(), 'usage-sentinel');
      const result = runHook(script, {
        input: { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } },
        env: { USAGE_SENTINEL_DIR: dir },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(existsSync(dir), false);
    });
  }
});

describe('session-start.mjs', () => {
  test('啟動時建立狀態資料夾與預設 config.json', () => {
    const dir = join(tempDir(), 'usage-sentinel');
    const result = runHook('session-start.mjs', {
      input: { session_id: 's1', source: 'startup' },
      env: { USAGE_SENTINEL_DIR: dir },
    });
    assert.equal(result.code, 0, result.stderr);
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    assert.equal(config.enabled, true);
    assert.deepEqual(config.thresholds, { warn: 75, wind_down: 85, stop: 92 });
  });

  test('不覆寫既有的 config.json', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'config.json'), '{"enabled":false}');
    runHook('session-start.mjs', { input: { source: 'startup' }, env: { USAGE_SENTINEL_DIR: dir } });
    assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), '{"enabled":false}');
  });

  // 舊 session 在移除後遇到 /compact 或 /clear 也會觸發 SessionStart，不能把資料夾長回來。
  for (const source of ['compact', 'clear']) {
    test(`source=${source} 且資料夾不存在時不建立`, () => {
      const dir = join(tempDir(), 'usage-sentinel');
      const result = runHook('session-start.mjs', { input: { source }, env: { USAGE_SENTINEL_DIR: dir } });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(existsSync(dir), false);
    });
  }

  test('USAGE_SENTINEL_DISABLE=1 時什麼都不做', () => {
    const dir = join(tempDir(), 'usage-sentinel');
    runHook('session-start.mjs', {
      input: { source: 'startup' },
      env: { USAGE_SENTINEL_DIR: dir, USAGE_SENTINEL_DISABLE: '1' },
    });
    assert.equal(existsSync(dir), false);
  });

  test('stdin 不是合法 JSON 時仍 exit 0', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const result = runHook('session-start.mjs', { input: 'not json', env: { USAGE_SENTINEL_DIR: dir } });
    assert.equal(result.code, 0, result.stderr);
  });
});

describe('hooks/hooks.json', () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const expected = {
    PreToolUse: { script: 'guard.mjs', timeout: 150, matcher: '*' },
    PostToolUse: { script: 'post.mjs', timeout: 10, matcher: '*' },
    UserPromptSubmit: { script: 'prompt.mjs', timeout: 10 },
    SessionStart: { script: 'session-start.mjs', timeout: 10 },
  };

  test('只註冊四個事件', () => {
    assert.deepEqual(Object.keys(hooks).sort(), Object.keys(expected).sort());
  });

  for (const [event, { script, timeout, matcher }] of Object.entries(expected)) {
    test(`${event} 指向 ${script}，timeout ${timeout}`, () => {
      assert.equal(hooks[event].length, 1);
      const [entry] = hooks[event];
      assert.equal(entry.matcher, matcher);
      assert.equal(entry.hooks.length, 1);
      const [hook] = entry.hooks;
      assert.equal(hook.type, 'command');
      assert.equal(hook.timeout, timeout);
      assert.match(hook.command, new RegExp(`\\$\\{CLAUDE_PLUGIN_ROOT\\}/scripts/${script.replace('.', '\\.')}`));
      assert.ok(existsSync(join(ROOT, 'scripts', script)), `${script} 不存在`);
    });
  }
});
