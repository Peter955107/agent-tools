// 模擬 claude CLI 的 plugin 指令，狀態存在 FAKE_CLAUDE_STATE 指向的 JSON：
// { plugins: [{ id, scope, projectPath? }], failUninstallScopes: [], calls: [] }
// 行為參考 E9：uninstall 會移除 enabledPlugins、刪除 plugins/data，cache 只留 .orphaned_at；
// marketplace remove 會移除市集宣告與 known_marketplaces.json 的項目。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const statePath = process.env.FAKE_CLAUDE_STATE;
const claude = process.env.CLAUDE_CONFIG_DIR;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
state.calls.push({ args, cwd: process.cwd() });
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const readJson = (p, f) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : f);
const option = (name) => args[args.indexOf(name) + 1];

function settingsFile(scope, projectPath) {
  if (scope === 'user') return join(claude, 'settings.json');
  return join(projectPath, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json');
}

const [group, action] = args;
if (group === 'plugin' && action === 'list') {
  save();
  process.stdout.write(JSON.stringify(state.plugins));
} else if (group === 'plugin' && action === 'uninstall') {
  const id = args[2];
  const scope = option('--scope') ?? 'user';
  if (state.failUninstallScopes.includes(scope)) {
    save();
    process.stdout.write(JSON.stringify({ success: false, failureCode: 'settings_still_on' }));
    process.exit(1);
  }
  const entry = state.plugins.find((p) => p.id === id && p.scope === scope);
  state.plugins = state.plugins.filter((p) => p !== entry);
  const file = settingsFile(scope, entry?.projectPath);
  const settings = readJson(file, null);
  if (settings?.enabledPlugins) {
    delete settings.enabledPlugins[id];
    // E9：Claude Code 寫入設定時會把 model 正規化（opus → opus[1m]）。
    if (state.normalizeModel && settings.model === 'opus') settings.model = 'opus[1m]';
    writeFileSync(file, JSON.stringify(settings, null, 2));
  }
  if (!state.plugins.some((p) => p.id === id)) {
    rmSync(join(claude, 'plugins', 'data', id.replace('@', '-')), { recursive: true, force: true });
    const [name, market] = id.split('@');
    const cache = join(claude, 'plugins', 'cache', market, name);
    if (existsSync(cache)) for (const version of readdirSync(cache)) writeFileSync(join(cache, version, '.orphaned_at'), String(Date.now()));
  }
  save();
  process.stdout.write(JSON.stringify({ success: true }));
} else if (group === 'plugin' && action === 'marketplace' && args[2] === 'remove') {
  const market = args[3];
  const settingsPath = join(claude, 'settings.json');
  const settings = readJson(settingsPath, null);
  if (settings?.extraKnownMarketplaces) {
    delete settings.extraKnownMarketplaces[market];
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }
  const knownPath = join(claude, 'plugins', 'known_marketplaces.json');
  const known = readJson(knownPath, {});
  delete known[market];
  mkdirSync(join(claude, 'plugins'), { recursive: true });
  writeFileSync(knownPath, JSON.stringify(known, null, 2));
  save();
} else {
  save();
  process.stderr.write(`fake-claude: unsupported ${args.join(' ')}`);
  process.exit(2);
}
