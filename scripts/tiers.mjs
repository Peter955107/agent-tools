// 分段判斷與注入文字（FR-2）。純函式，不做 I/O。

export const TIERS = ['normal', 'warn', 'wind_down', 'stop'];

const WINDOW_LABELS = { five_hour: '5 小時', seven_day: '7 天' };

// 重置時間已過的視窗視為 0%（C11）。
export function effectivePct(win, nowMs) {
  if (win.resets_at !== null && win.resets_at !== undefined && win.resets_at * 1000 < nowMs) return 0;
  return win.pct;
}

function tierOf(pct, thresholds) {
  if (pct >= thresholds.stop) return 'stop';
  if (pct >= thresholds.wind_down) return 'wind_down';
  if (pct >= thresholds.warn) return 'warn';
  return 'normal';
}

// 對每個啟用的視窗各自計算，取最嚴重的分段；同分段時取百分比較高者為觸發視窗。
export function computeTier(snapshot, config, nowMs) {
  const windows = config.windows
    .filter((name) => snapshot.windows[name])
    .map((name) => {
      const win = snapshot.windows[name];
      const pct = effectivePct(win, nowMs);
      return { window: name, pct, resets_at: win.resets_at, tier: tierOf(pct, config.thresholds) };
    });
  let trigger = null;
  for (const win of windows) {
    const rank = TIERS.indexOf(win.tier);
    const best = trigger ? TIERS.indexOf(trigger.tier) : -1;
    if (rank > best || (rank === best && win.pct > trigger.pct)) trigger = win;
  }
  return { tier: trigger ? trigger.tier : 'normal', trigger, windows };
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds / 60));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days > 0) return `${days} 天 ${hours} 小時`;
  if (hours > 0) return `${hours} 小時 ${minutes} 分`;
  return `${minutes} 分`;
}

function describeWindow(win, nowMs) {
  const pct = `${WINDOW_LABELS[win.window]}用量 ${Math.round(win.pct)}%`;
  if (win.resets_at === null || win.resets_at === undefined || win.pct === 0) return pct;
  return `${pct}（${formatDuration(win.resets_at - nowMs / 1000)}後重置）`;
}

export function usageLine(result, nowMs) {
  return `usage-sentinel：${result.windows.map((w) => describeWindow(w, nowMs)).join(' · ')}`;
}

// warn 只給一行用量；wind-down（以及尚未實作停止前的 stop）附上收尾指示。
export function injectionText(result, config, nowMs) {
  const line = usageLine(result, nowMs);
  if (result.tier === 'warn') return line;
  const planHint = config.plan_files.length ? `（${config.plan_files.join('、')}）` : '';
  return [
    `${line}。已進入收尾階段，請：`,
    '1. 不要開始新的大型步驟。',
    '2. 把手上的修改 commit。',
    `3. 更新 ${config.resume_file}：做了什麼、下一步、未完成的地方。`,
    `4. 若有 plan 文件${planHint}，在 plan 上標記目前進度。`,
  ].join('\n');
}
