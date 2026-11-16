import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, isolatedEnv, tempDir } from '../test-support/helpers.mjs';

const SCRIPT = join(ROOT, 'scripts', 'statusline.mjs');
const now = () => Math.floor(Date.now() / 1000);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function statusInput(rateLimits) {
  return { session_id: 's', model: { id: 'claude-opus-5-5', display_name: 'Opus' }, workspace: { current_dir: 'C:/work' }, ...(rateLimits && { rate_limits: rateLimits }) };
}

function run(dir, input, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input),
    env: isolatedEnv({ USAGE_SENTINEL_DIR: dir, ...env }),
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const cache = (dir) => JSON.parse(readFileSync(join(dir, 'cache.json'), 'utf8'));

describe('statusline.mjs', () => {
  test('寫入快取並顯示「5h 62% (2h10m) · 7d 38%」', () => {
    const dir = tempDir();
    const fiveReset = now() + 2 * 3600 + 10 * 60 + 30;
    const out = run(dir, statusInput({ five_hour: { used_percentage: 62, resets_at: fiveReset }, seven_day: { used_percentage: 38, resets_at: now() + 86400 } }));
    assert.equal(stripAnsi(out).trim(), '5h 62% (2h10m) · 7d 38%');
    const windows = cache(dir).windows;
    assert.equal(windows.five_hour.pct, 62);
    assert.equal(windows.five_hour.resets_at, fiveReset);
    assert.equal(windows.five_hour.source, 'statusline');
  });

  test('沒有 rate_limits 時不覆寫用量，只更新最後檢查時間，並顯示快取內容', () => {
    const dir = tempDir();
    const existing = { window: 'five_hour', pct: 70, resets_at: now() + 3600, observed_at: now() - 30, source: 'endpoint' };
    writeFileSync(join(dir, 'cache.json'), JSON.stringify({ windows: { five_hour: existing } }));
    const out = run(dir, statusInput(null));
    assert.match(stripAnsi(out), /5h 70%/);
    const written = cache(dir);
    assert.deepEqual(written.windows.five_hour, existing);
    assert.equal(typeof written.statusline_checked_at, 'number');
  });

  test('同一週期內百分比不下降', () => {
    const dir = tempDir();
    const reset = now() + 3600;
    writeFileSync(join(dir, 'cache.json'), JSON.stringify({ windows: { five_hour: { window: 'five_hour', pct: 70, resets_at: reset + 0.4, observed_at: now() - 30, source: 'endpoint' } } }));
    run(dir, statusInput({ five_hour: { used_percentage: 69, resets_at: reset } }));
    assert.equal(cache(dir).windows.five_hour.pct, 70);
  });

  test('重置時間已過的視窗顯示 0%', () => {
    const dir = tempDir();
    const out = run(dir, statusInput({ five_hour: { used_percentage: 95, resets_at: now() - 10 } }));
    assert.match(stripAnsi(out), /5h 0%/);
  });

  test('依分段變色：stop 為紅色、warn 為黃色', () => {
    const dir = tempDir();
    const out = run(dir, statusInput({ five_hour: { used_percentage: 93, resets_at: now() + 3600 }, seven_day: { used_percentage: 80, resets_at: now() + 86400 } }));
    assert.match(out, /\x1b\[31m5h 93%/);
    assert.match(out, /\x1b\[33m7d 80%/);
  });

  test('使用設定檔的門檻', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ thresholds: { warn: 50, wind_down: 60, stop: 70 } }));
    const out = run(dir, statusInput({ five_hour: { used_percentage: 72, resets_at: now() + 3600 } }));
    assert.match(out, /\x1b\[31m5h 72%/);
  });

  const HUD = `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('HUD '+JSON.parse(s).model.display_name))"`;

  test('串接原本的 statusLine：同一份 stdin，輸出接在後面', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ chain_statusline: { type: 'command', command: HUD } }));
    const out = stripAnsi(run(dir, statusInput({ five_hour: { used_percentage: 10, resets_at: now() + 3630 } }))).trim().split('\n');
    assert.equal(out[0], '5h 10% (1h0m)');
    assert.equal(out[1], 'HUD Opus');
  });

  test('原本的 statusLine 失敗時只顯示本工具的輸出', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ chain_statusline: { type: 'command', command: 'exit 3' } }));
    const out = stripAnsi(run(dir, statusInput({ five_hour: { used_percentage: 10, resets_at: now() + 3630 } }))).trim();
    assert.equal(out, '5h 10% (1h0m)');
  });

  test('DISABLED 時不寫快取，只執行原本的 statusLine', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ chain_statusline: { type: 'command', command: HUD } }));
    writeFileSync(join(dir, 'DISABLED'), '');
    const out = stripAnsi(run(dir, statusInput({ five_hour: { used_percentage: 10, resets_at: now() + 3630 } }))).trim();
    assert.equal(out, 'HUD Opus');
    assert.equal(existsSync(join(dir, 'cache.json')), false);
  });

  test('狀態資料夾不存在時不建立它', () => {
    const dir = join(tempDir(), 'missing');
    run(dir, statusInput({ five_hour: { used_percentage: 10, resets_at: now() + 3630 } }));
    assert.equal(existsSync(dir), false);
  });

  test('單一檔案、不 import 專案內其他模組（會被複製到 bin/ 單獨執行）', () => {
    assert.doesNotMatch(readFileSync(SCRIPT, 'utf8'), /from ['"]\.{1,2}\//);
  });
});
