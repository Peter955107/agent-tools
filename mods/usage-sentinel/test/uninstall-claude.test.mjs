import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, isolatedEnv, tempDir } from '../test-support/helpers.mjs';

const SCRIPT = join(ROOT, 'scripts', 'uninstall.mjs');
const ID = 'usage-sentinel@usage-sentinel';

// 安裝在 user 範圍（可另加其他範圍）的完整情境：settings、市集宣告、cache、data、狀態資料夾。
function installed({ extraPlugins = [], failUninstallScopes = [] } = {}) {
  const claude = tempDir();
  const dir = join(claude, 'usage-sentinel');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ tool: 'usage-sentinel', marketplace: 'usage-sentinel', statusline: { installed: false } }));
  const settings = {
    model: 'opus',
    enabledPlugins: { [ID]: true, 'other@elsewhere': true },
    extraKnownMarketplaces: { 'usage-sentinel': { source: { source: 'directory', path: 'C:/dev/usage-sentinel' } } },
  };
  writeFileSync(join(claude, 'settings.json'), JSON.stringify(settings, null, 2));
  mkdirSync(join(claude, 'plugins', 'cache', 'usage-sentinel', 'usage-sentinel', '0.3.6'), { recursive: true });
  mkdirSync(join(claude, 'plugins', 'data', 'usage-sentinel-usage-sentinel'), { recursive: true });
  writeFileSync(join(claude, 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'usage-sentinel': {}, elsewhere: {} }));

  const plugins = [{ id: ID, scope: 'user' }, { id: 'other@elsewhere', scope: 'user' }];
  for (const extra of extraPlugins) {
    plugins.push(extra);
    if (extra.projectPath) {
      mkdirSync(join(extra.projectPath, '.claude'), { recursive: true });
      const file = join(extra.projectPath, '.claude', extra.scope === 'local' ? 'settings.local.json' : 'settings.json');
      writeFileSync(file, JSON.stringify({ enabledPlugins: { [extra.id]: true } }, null, 2));
    }
  }
  const statePath = join(tempDir(), 'fake-claude.json');
  writeFileSync(statePath, JSON.stringify({ plugins, failUninstallScopes, calls: [] }));
  return { claude, dir, statePath };
}

// USAGE_SENTINEL_CLAUDE_BIN／USAGE_SENTINEL_UNINSTALL_PROCESSES：測試用，只在設了 USAGE_SENTINEL_DIR 時生效。
function uninstall(ctx, args = ['--yes'], { processes = [] } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: isolatedEnv({
      USAGE_SENTINEL_DIR: ctx.dir,
      CLAUDE_CONFIG_DIR: ctx.claude,
      USAGE_SENTINEL_CLAUDE_BIN: join(ROOT, 'test-support', 'fake-claude.mjs'),
      USAGE_SENTINEL_UNINSTALL_PROCESSES: JSON.stringify(processes),
      FAKE_CLAUDE_STATE: ctx.statePath,
    }),
    encoding: 'utf8',
    timeout: 60000,
  });
  return { code: result.status, out: result.stdout + result.stderr };
}

const calls = (ctx) => JSON.parse(readFileSync(ctx.statePath, 'utf8')).calls.map((c) => ({ args: c.args.join(' '), cwd: c.cwd }));
const settingsOf = (ctx) => JSON.parse(readFileSync(join(ctx.claude, 'settings.json'), 'utf8'));
const session = { pid: 4242, ppid: 1, name: 'claude.exe', path: 'C:\\Users\\u\\.vscode\\extensions\\anthropic.claude-code\\claude.exe' };

describe('步驟 0：執行中的 Claude Code session（驗收 17）', () => {
  test('有其他 session 開著時拒絕執行並列出程序，不做任何變更', () => {
    const ctx = installed();
    const { code, out } = uninstall(ctx, ['--yes'], { processes: [session] });
    assert.equal(code, 1, out);
    assert.match(out, /4242/);
    assert.match(out, /--force/);
    assert.equal(existsSync(join(ctx.dir, 'DISABLED')), false);
    assert.equal(calls(ctx).filter((c) => c.args.includes('uninstall')).length, 0);
  });

  test('--force 時繼續，cache 保留給 Claude Code 回收並標示 ⏳', () => {
    const ctx = installed();
    const { code, out } = uninstall(ctx, ['--yes', '--force'], { processes: [session] });
    assert.equal(code, 0, out);
    assert.ok(existsSync(join(ctx.claude, 'plugins', 'cache', 'usage-sentinel', 'usage-sentinel')));
    assert.match(out, /⏳/);
  });

  test('自己的上層程序（從 Claude Code 裡執行移除時）不算', () => {
    const ctx = installed();
    const parent = { pid: process.pid, ppid: 1, name: 'claude.exe', path: 'C:\\claude.exe' };
    const { code, out } = uninstall(ctx, ['--yes'], { processes: [parent] });
    assert.equal(code, 0, out);
  });
});

describe('步驟 10：設定差異（驗收 20）', () => {
  test('列出不是本工具造成的變動，並附上備份路徑', () => {
    const ctx = installed();
    const state = JSON.parse(readFileSync(ctx.statePath, 'utf8'));
    writeFileSync(ctx.statePath, JSON.stringify({ ...state, normalizeModel: true }));
    const { out } = uninstall(ctx);
    assert.match(out, /不是本工具造成的設定變動/);
    assert.match(out, /model："opus" → "opus\[1m\]"/);
    assert.match(out, /backups[\\/]usage-sentinel[\\/].+-uninstall/);
  });

  test('只有本工具預期的變動時，說明沒有其他變動', () => {
    const ctx = installed();
    const { out } = uninstall(ctx);
    assert.match(out, /settings\.json 沒有其他變動/);
    assert.doesNotMatch(out, /enabledPlugins\.usage-sentinel@usage-sentinel：/);
    assert.doesNotMatch(out, /extraKnownMarketplaces\.usage-sentinel：/);
  });
});

describe('步驟 5–7：plugin、市集、cache', () => {
  test('完整移除：uninstall、移除市集宣告、刪除 cache，自我檢查全部 ✅（驗收 12）', () => {
    const ctx = installed();
    const { code, out } = uninstall(ctx);
    assert.equal(code, 0, out);
    const invoked = calls(ctx).map((c) => c.args);
    assert.ok(invoked.includes(`plugin uninstall ${ID} --scope user --json`), invoked.join('\n'));
    assert.ok(invoked.includes('plugin marketplace remove usage-sentinel'), invoked.join('\n'));
    assert.equal(existsSync(join(ctx.claude, 'plugins', 'cache', 'usage-sentinel', 'usage-sentinel')), false);
    const settings = settingsOf(ctx);
    assert.equal(ID in settings.enabledPlugins, false);
    assert.equal(settings.enabledPlugins['other@elsewhere'], true, '其他 plugin 不受影響');
    assert.doesNotMatch(out, /⚠️/);
  });

  test('同時裝在 user 與 project 範圍：兩個都移除，project 在該專案目錄下執行（驗收 19）', () => {
    const project = tempDir();
    const ctx = installed({ extraPlugins: [{ id: ID, scope: 'project', projectPath: project }] });
    const { code, out } = uninstall(ctx);
    assert.equal(code, 0, out);
    const uninstalls = calls(ctx).filter((c) => c.args.startsWith('plugin uninstall'));
    assert.deepEqual(uninstalls.map((c) => c.args).sort(), [`plugin uninstall ${ID} --scope project --json`, `plugin uninstall ${ID} --scope user --json`]);
    assert.equal(uninstalls.find((c) => c.args.includes('project')).cwd.toLowerCase(), project.toLowerCase());
  });

  test('project 範圍移除失敗時，改為直接刪除 enabledPlugins 項目並印出手動步驟', () => {
    const project = tempDir();
    const ctx = installed({ extraPlugins: [{ id: ID, scope: 'project', projectPath: project }], failUninstallScopes: ['project'] });
    const { out } = uninstall(ctx);
    const projectSettings = JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8'));
    assert.equal(ID in projectSettings.enabledPlugins, false);
    assert.match(out, /手動/);
  });

  test('市集還有其他安裝中的 plugin 時，不移除市集宣告', () => {
    const ctx = installed({ extraPlugins: [{ id: 'helper@usage-sentinel', scope: 'user' }] });
    uninstall(ctx);
    assert.equal(calls(ctx).some((c) => c.args.startsWith('plugin marketplace remove')), false);
  });

  test('--dry-run 列出各範圍的安裝，但不移除', () => {
    const ctx = installed();
    const { code, out } = uninstall(ctx, ['--dry-run']);
    assert.equal(code, 0, out);
    assert.match(out, /usage-sentinel@usage-sentinel（user）/);
    assert.equal(calls(ctx).some((c) => c.args.startsWith('plugin uninstall')), false);
  });

  test('--skip-claude 不呼叫 claude', () => {
    const ctx = installed();
    uninstall(ctx, ['--yes', '--skip-claude']);
    assert.deepEqual(calls(ctx), []);
  });

  test('自我檢查：不只相信 uninstall 的回傳，重新列出確認', () => {
    const ctx = installed();
    uninstall(ctx);
    const lists = calls(ctx).filter((c) => c.args === 'plugin list --json');
    assert.ok(lists.length >= 2, '移除前後各列一次');
  });
});
