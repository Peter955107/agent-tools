import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../scripts/cli.mjs';
import { installStatusline } from '../scripts/install-statusline.mjs';
import { isolatedEnv, tempDir } from '../test-support/helpers.mjs';

const HUD = { type: 'command', command: "bash -c 'node ~/hud.js'", padding: 0 };

function setup(settings) {
  const claude = tempDir();
  const dir = join(claude, 'usage-sentinel');
  if (settings !== undefined) {
    writeFileSync(join(claude, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  }
  const env = isolatedEnv({ USAGE_SENTINEL_DIR: dir, CLAUDE_CONFIG_DIR: claude });
  return { claude, dir, env };
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const expectedCommand = (dir) => `node "${join(dir, 'bin', 'statusline.mjs').replace(/\\/g, '/')}"`;

describe('installStatusline', () => {
  test('只改 statusLine 一個鍵，其他設定不變', () => {
    const original = { model: 'opus', permissions: { allow: ['Bash(git:*)'] }, statusLine: HUD };
    const { claude, dir, env } = setup(original);
    const { code } = installStatusline({ env });
    assert.equal(code, 0);
    const settings = readJson(join(claude, 'settings.json'));
    assert.deepEqual(settings.statusLine, { type: 'command', command: expectedCommand(dir), padding: 0 });
    const { statusLine, ...rest } = settings;
    const { statusLine: _, ...originalRest } = original;
    assert.deepEqual(rest, originalRest);
  });

  test('原本的 statusLine 存進 chain_statusline', () => {
    const { dir, env } = setup({ statusLine: HUD });
    installStatusline({ env });
    assert.deepEqual(readJson(join(dir, 'config.json')).chain_statusline, HUD);
  });

  test('修改前先備份 settings.json，並記錄在 manifest', () => {
    const { claude, dir, env } = setup({ model: 'opus', statusLine: HUD });
    const before = readFileSync(join(claude, 'settings.json'), 'utf8');
    installStatusline({ env });
    const manifest = readJson(join(dir, 'manifest.json'));
    assert.equal(manifest.statusline.installed, true);
    assert.equal(manifest.statusline.command, expectedCommand(dir));
    assert.deepEqual(manifest.statusline.original, HUD);
    assert.ok(manifest.statusline.backup.startsWith(join(claude, 'backups', 'usage-sentinel')));
    assert.equal(readFileSync(join(manifest.statusline.backup, 'settings.json'), 'utf8'), before);
  });

  test('把 statusline.mjs 放到 bin/', () => {
    const { dir, env } = setup({});
    installStatusline({ env });
    assert.ok(existsSync(join(dir, 'bin', 'statusline.mjs')));
  });

  test('已經安裝過時不再修改，也不把自己存成 chain', () => {
    const { claude, dir, env } = setup({ statusLine: HUD });
    installStatusline({ env });
    const settingsBefore = readFileSync(join(claude, 'settings.json'), 'utf8');
    const { code, text } = installStatusline({ env });
    assert.equal(code, 0);
    assert.match(text, /已經安裝/);
    assert.equal(readFileSync(join(claude, 'settings.json'), 'utf8'), settingsBefore);
    assert.deepEqual(readJson(join(dir, 'config.json')).chain_statusline, HUD);
  });

  test('原本沒有 statusLine 時 chain 為 null', () => {
    const { claude, dir, env } = setup({ model: 'opus' });
    installStatusline({ env });
    assert.equal(readJson(join(dir, 'config.json')).chain_statusline, null);
    assert.equal(readJson(join(claude, 'settings.json')).statusLine.command, expectedCommand(dir));
  });

  test('settings.json 不存在時建立，只含 statusLine', () => {
    const { claude, dir, env } = setup(undefined);
    assert.equal(installStatusline({ env }).code, 0);
    assert.deepEqual(readJson(join(claude, 'settings.json')), { statusLine: { type: 'command', command: expectedCommand(dir) } });
  });

  test('settings.json 不是合法 JSON 時不動它', () => {
    const { claude, env } = setup('{ broken');
    const { code, text } = installStatusline({ env });
    assert.equal(code, 1);
    assert.match(text, /不是合法 JSON/);
    assert.equal(readFileSync(join(claude, 'settings.json'), 'utf8'), '{ broken');
  });

  test('保留 config.json 既有的其他設定', () => {
    const { dir, env } = setup({ statusLine: HUD });
    installStatusline({ env });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ snooze_step: 5, chain_statusline: HUD }));
    assert.equal(readJson(join(dir, 'config.json')).snooze_step, 5);
  });
});

test('/usage-sentinel install-statusline 子指令', async () => {
  const { claude, dir, env } = setup({ statusLine: HUD });
  const { code } = await runCli(['install-statusline'], { env });
  assert.equal(code, 0);
  assert.equal(readJson(join(claude, 'settings.json')).statusLine.command, expectedCommand(dir));
});
