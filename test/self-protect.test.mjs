import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selfProtection } from '../scripts/self-protect.mjs';
import { runHook, tempDir } from '../test-support/helpers.mjs';

const ENV = { CLAUDE_CONFIG_DIR: 'C:\\Users\\u\\.claude' };
const CWD = 'C:\\work\\app';
const check = (tool_name, tool_input, env = ENV) => selfProtection({ tool_name, tool_input, cwd: CWD }, { env, platform: 'win32' });
const decision = (...args) => check(...args)?.decision ?? null;

describe('檔案工具寫入受保護路徑', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    test(`${tool} 寫入狀態資料夾 → deny`, () => {
      assert.equal(decision(tool, { file_path: 'C:\\Users\\u\\.claude\\usage-sentinel\\config.json' }), 'deny');
    });
  }

  test('路徑大小寫與斜線方向不影響判斷（Windows）', () => {
    assert.equal(decision('Edit', { file_path: 'c:/users/U/.Claude/Usage-Sentinel/snooze.json' }), 'deny');
  });

  test('寫入 credentials → deny', () => {
    assert.equal(decision('Write', { file_path: 'C:\\Users\\u\\.claude\\.credentials.json' }), 'deny');
  });

  test('NotebookEdit 用 notebook_path 也會檢查', () => {
    assert.equal(decision('NotebookEdit', { notebook_path: 'C:\\Users\\u\\.claude\\usage-sentinel\\x.ipynb' }), 'deny');
  });

  test('同層的其他設定檔不受影響', () => {
    assert.equal(decision('Write', { file_path: 'C:\\Users\\u\\.claude\\settings.json' }), null);
  });

  test('名稱只是前綴相同的資料夾不受影響', () => {
    assert.equal(decision('Write', { file_path: 'C:\\Users\\u\\.claude\\usage-sentinel-notes\\a.md' }), null);
  });

  test('Read 不受限制', () => {
    assert.equal(decision('Read', { file_path: 'C:\\Users\\u\\.claude\\usage-sentinel\\config.json' }), null);
  });

  test('USAGE_SENTINEL_DIR 改過位置時保護新位置', () => {
    const env = { ...ENV, USAGE_SENTINEL_DIR: 'D:\\state' };
    assert.equal(decision('Write', { file_path: 'D:\\state\\stopped.json' }, env), 'deny');
  });
});

describe('Bash／PowerShell 指令中出現受保護路徑', () => {
  const denied = [
    ['Bash', 'echo {} > ~/.claude/usage-sentinel/snooze.json'],
    ['Bash', 'rm -rf "$HOME/.claude/usage-sentinel"'],
    ['Bash', 'touch /c/Users/u/.claude/usage-sentinel/DISABLED'],
    ['Bash', 'cat ~/.claude/.credentials.json'],
    ['PowerShell', 'Remove-Item $env:USERPROFILE\\.claude\\usage-sentinel\\stopped.json'],
    ['PowerShell', 'Set-Content C:\\Users\\u\\.claude\\usage-sentinel\\config.json "{}"'],
    ['Bash', 'cmd /c del %USERPROFILE%\\.claude\\usage-sentinel\\stopped.json'],
  ];
  for (const [tool, command] of denied) {
    test(`${tool} 擋下：${command}`, () => {
      assert.equal(decision(tool, { command }), 'deny');
    });
  }

  test('USAGE_SENTINEL_DIR 改過位置時，絕對路徑與 Git Bash 寫法都會擋', () => {
    const env = { ...ENV, USAGE_SENTINEL_DIR: 'D:\\state' };
    assert.equal(decision('Bash', { command: 'rm D:\\state\\stopped.json' }, env), 'deny');
    assert.equal(decision('Bash', { command: 'rm /d/state/stopped.json' }, env), 'deny');
  });

  const allowed = ['git commit -m "update usage-sentinel docs"', 'ls ~/.claude/plugins', 'npm test', 'cat ~/.claude/settings.json'];
  for (const command of allowed) {
    test(`不影響：${command}`, () => {
      assert.equal(decision('Bash', { command }), null);
    });
  }
});

describe('執行本工具的指令', () => {
  test('執行 uninstall.mjs → ask，由人決定（FR-8.2）', () => {
    const result = check('Bash', { command: 'node ~/.claude/usage-sentinel/bin/uninstall.mjs --yes' });
    assert.equal(result.decision, 'ask');
    assert.match(result.reason, /移除 usage-sentinel/);
  });

  test('PowerShell 執行 uninstall.mjs 也是 ask', () => {
    assert.equal(decision('PowerShell', { command: 'node "$env:USERPROFILE\\.claude\\usage-sentinel\\bin\\uninstall.mjs"' }), 'ask');
  });

  test('agent 直接執行本工具的 cli.mjs → deny', () => {
    const command = 'node "C:/Users/u/.claude/plugins/cache/usage-sentinel/usage-sentinel/0.2.1/scripts/cli.mjs" snooze 600';
    assert.equal(decision('Bash', { command }), 'deny');
  });

  test('agent 直接執行 install-statusline.mjs → deny', () => {
    assert.equal(decision('Bash', { command: 'node C:\\x\\usage-sentinel\\scripts\\install-statusline.mjs' }), 'deny');
  });

  test('其他專案的 cli.mjs 不受影響', () => {
    assert.equal(decision('Bash', { command: 'node scripts/cli.mjs build' }), null);
  });

  test('在本工具的 repo 裡用相對路徑執行 cli.mjs → deny', () => {
    const result = selfProtection(
      { tool_name: 'Bash', tool_input: { command: 'node scripts/cli.mjs snooze 600' }, cwd: 'C:\\dev\\usage-sentinel' },
      { env: ENV, platform: 'win32' },
    );
    assert.equal(result?.decision, 'deny');
  });

  // 回歸：只是提到 cli.mjs（例如用腳本修改它），而不是執行它，不應該被擋。
  const notExecuting = [
    `cd "C:/dev/usage-sentinel" && node -e "require('fs').readFileSync('scripts/cli.mjs')"`,
    'cd C:/dev/usage-sentinel && git diff scripts/cli.mjs',
    'cd C:/dev/usage-sentinel && grep -n status scripts/cli.mjs scripts/install-statusline.mjs',
    'cd C:/dev/usage-sentinel && node --test test/cli.test.mjs',
    'cd C:/dev/usage-sentinel && git diff scripts/uninstall.mjs',
  ];
  for (const command of notExecuting) {
    test(`只是提到、沒有執行：${command}`, () => {
      assert.equal(decision('Bash', { command }), null);
    });
  }
});

describe('guard.mjs 套用自我保護', () => {
  const NOW = Math.floor(Date.now() / 1000);

  function guard(dir, input) {
    const result = runHook('guard.mjs', { input: { session_id: 's', cwd: CWD, ...input }, env: { USAGE_SENTINEL_DIR: dir } });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : {};
  }

  test('normal 分段也會擋下寫入狀態資料夾（驗收 9）', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'fake-usage.json'), JSON.stringify({ five_hour: { utilization: 10, resets_at: NOW + 3600 } }));
    const output = guard(dir, { tool_name: 'Write', tool_input: { file_path: join(dir, 'config.json'), content: '{}' } });
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /自我保護/);
    assert.equal(output.continue, undefined);
  });

  test('資料不可用時仍會擋', () => {
    const dir = tempDir();
    const output = guard(dir, { tool_name: 'Bash', tool_input: { command: `rm ${join(dir, 'stopped.json')}` } });
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  });

  test('已停止時，自我保護優先於收尾允許清單', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'stopped.json'), JSON.stringify({ window: 'five_hour', pct: 93, resets_at: NOW + 3600, reason: 'user', denials: 0 }));
    const output = guard(dir, { tool_name: 'Bash', tool_input: { command: `git commit -m x` } });
    assert.deepEqual(output, {});
    const blocked = guard(dir, { tool_name: 'Write', tool_input: { file_path: join(dir, 'stopped.json'), content: '{}' } });
    assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /自我保護/);
  });
});
