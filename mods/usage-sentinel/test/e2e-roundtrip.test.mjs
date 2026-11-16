// 驗收 21：在隔離的 CLAUDE_CONFIG_DIR 中用真的 claude CLI 做「安裝 → 使用 → 移除」往返，
// 結束後與安裝前的檔案清單比對。會呼叫真實的 claude CLI，只在 USAGE_SENTINEL_E2E=1 時執行：
//   USAGE_SENTINEL_E2E=1 node --test test/e2e-roundtrip.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, tempDir } from '../test-support/helpers.mjs';

function listFiles(root, dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) listFiles(root, path, out);
    else out.push(relative(root, path).replace(/\\/g, '/'));
  }
  return out;
}

// Claude Code 自己的檔案（需求書驗收 21 的例外）。plugin 登記檔在第一次安裝任何 plugin 時建立、
// 移除後仍保留給之後的安裝使用，屬於 Claude Code；但內容不得留有本工具的項目（下方另外檢查）。
const PLUGIN_REGISTRIES = ['plugins/installed_plugins.json', 'plugins/known_marketplaces.json'];
const isClaudeOwn = (path) =>
  path === '.claude.json' || path.startsWith('.claude.json.') || path.startsWith('backups/') || PLUGIN_REGISTRIES.includes(path);

test('安裝 → 使用 → 移除後，除了 Claude Code 自己的檔案之外沒有殘留', { skip: process.env.USAGE_SENTINEL_E2E !== '1', timeout: 300000 }, () => {
  const claude = tempDir();
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ model: 'opus' }, null, 2));
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claude,
    USAGE_SENTINEL_DIR: join(claude, 'usage-sentinel'),
    USAGE_SENTINEL_UNINSTALL_PROCESSES: '[]', // 這是隔離環境，使用者其他開著的 session 與它無關
    MSYS_NO_PATHCONV: '1',
  };
  delete env.USAGE_SENTINEL_DISABLE;
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 120000, shell: command === 'claude' && process.platform === 'win32', ...options });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const before = listFiles(claude);

  // 安裝
  run('claude', ['plugin', 'marketplace', 'add', ROOT]);
  run('claude', ['plugin', 'install', 'usage-sentinel@usage-sentinel']);
  const installed = JSON.parse(run('claude', ['plugin', 'list', '--json'])).find((p) => p.id === 'usage-sentinel@usage-sentinel');
  assert.ok(installed, '應已安裝');
  const pluginRoot = installed.installPath;

  // 使用：SessionStart 建立狀態資料夾與 bin/、PreToolUse 跑一次、安裝 statusLine
  run(process.execPath, [join(pluginRoot, 'scripts', 'session-start.mjs')], { input: JSON.stringify({ source: 'startup', session_id: 'e2e' }) });
  writeFileSync(join(claude, 'usage-sentinel', 'fake-usage.json'), JSON.stringify({ five_hour: { utilization: 80, resets_at: Date.now() / 1000 + 3600 } }));
  run(process.execPath, [join(pluginRoot, 'scripts', 'guard.mjs')], { input: JSON.stringify({ session_id: 'e2e', tool_name: 'Read', tool_input: {} }) });
  run(process.execPath, [join(pluginRoot, 'scripts', 'install-statusline.mjs')]);

  // 移除：從 bin/ 的副本執行
  const output = run(process.execPath, [join(claude, 'usage-sentinel', 'bin', 'uninstall.mjs'), '--yes']);
  assert.doesNotMatch(output, /⚠️/, output);

  const after = listFiles(claude);
  const added = after.filter((p) => !before.includes(p) && !isClaudeOwn(p));
  const removed = before.filter((p) => !after.includes(p));
  assert.deepEqual({ added, removed }, { added: [], removed: [] }, `移除報告：\n${output}`);
  for (const registry of PLUGIN_REGISTRIES.filter((p) => after.includes(p))) {
    assert.doesNotMatch(readFileSync(join(claude, registry), 'utf8'), /usage-sentinel/, `${registry} 仍有本工具的項目`);
  }
});
