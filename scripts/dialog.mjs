// 停止詢問的對話框（FR-4.3）。Windows：Node → PowerShell -EncodedCommand → WinForms（A14）。
// 逾時由這裡計時並結束對話框程序，必須遠小於 hooks.json 的 150 秒（A12）。
import { spawn } from 'node:child_process';
import { formatDuration } from './tiers.mjs';

// 文字一律經由環境變數傳入，不嵌入腳本，避免跳脫問題與指令注入。
const WINFORMS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = $env:USAGE_SENTINEL_DIALOG_TITLE
$form.TopMost = $true
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.AutoSize = $true
$form.AutoSizeMode = 'GrowAndShrink'
$form.Padding = New-Object System.Windows.Forms.Padding(16)
$form.Font = New-Object System.Drawing.Font('Microsoft JhengHei UI', 10)
$layout = New-Object System.Windows.Forms.FlowLayoutPanel
$layout.FlowDirection = 'TopDown'
$layout.AutoSize = $true
$label = New-Object System.Windows.Forms.Label
$label.Text = $env:USAGE_SENTINEL_DIALOG_BODY
$label.AutoSize = $true
$label.MaximumSize = New-Object System.Drawing.Size(520, 0)
$label.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 16)
$layout.Controls.Add($label)
$row = New-Object System.Windows.Forms.FlowLayoutPanel
$row.FlowDirection = 'LeftToRight'
$row.AutoSize = $true
$script:choice = -1
$labels = $env:USAGE_SENTINEL_DIALOG_BUTTONS -split "\`n"
$defaultIndex = [int]$env:USAGE_SENTINEL_DIALOG_DEFAULT
for ($i = 0; $i -lt $labels.Count; $i++) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $labels[$i]
  $button.AutoSize = $true
  $button.Tag = $i
  $button.Add_Click({ $script:choice = $this.Tag; $form.Close() })
  $row.Controls.Add($button)
  if ($i -eq $defaultIndex) { $form.AcceptButton = $button; $form.ActiveControl = $button }
}
$layout.Controls.Add($row)
$form.Controls.Add($layout)
$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
[Console]::Out.Write($script:choice)
`;

export function powershellLaunch(spec) {
  const defaultIndex = spec.buttons.findIndex((b) => b.id === spec.defaultId);
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-EncodedCommand', Buffer.from(WINFORMS_SCRIPT, 'utf16le').toString('base64')],
    env: {
      ...process.env,
      USAGE_SENTINEL_DIALOG_TITLE: spec.title,
      USAGE_SENTINEL_DIALOG_BODY: spec.body,
      USAGE_SENTINEL_DIALOG_BUTTONS: spec.buttons.map((b) => b.label).join('\n'),
      USAGE_SENTINEL_DIALOG_DEFAULT: String(defaultIndex),
    },
  };
}

// 回傳 { choice, elapsedMs }。choice 為按鈕 id，或 'dismissed'（關閉視窗）、'timeout'、'unavailable'。
export function showDialog(spec, { platform = process.platform, launch, onSpawn } = {}) {
  const started = Date.now();
  const done = (choice) => ({ choice, elapsedMs: Date.now() - started });
  if (!launch) {
    if (platform !== 'win32') return Promise.resolve(done('unavailable')); // macOS／Linux 見任務 16
    launch = powershellLaunch;
  }
  const { command, args, env } = launch(spec);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(done(choice));
    };

    let child;
    try {
      child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: false });
    } catch {
      resolve(done('unavailable'));
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish('timeout');
    }, spec.timeoutSeconds * 1000);

    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('spawn', () => onSpawn?.(child.pid));
    child.on('error', () => finish('unavailable'));
    child.on('close', () => {
      const trimmed = stdout.trim();
      if (!/^-?\d+$/.test(trimmed)) return finish('unavailable');
      const index = Number(trimmed);
      if (index === -1) return finish('dismissed');
      finish(spec.buttons[index]?.id ?? 'unavailable');
    });
  });
}

const WINDOW_LABELS = { five_hour: '5 小時', seven_day: '7 天' };

export function buildStopDialog({ trigger, project, sessionId, nowMs, timeoutSeconds, fake = false }) {
  const remaining = formatDuration(trigger.resets_at - nowMs / 1000);
  const lines = [
    `${WINDOW_LABELS[trigger.window]}用量 ${Math.round(trigger.pct)}%，${remaining}後重置。`,
    '',
    `專案：${project}`,
    `session：${String(sessionId ?? '').slice(0, 8)}`,
  ];
  if (trigger.window === 'seven_day') lines.push('', `⚠ 繼續可能撞牆，需等 ${remaining}才會重置。`);
  lines.push('', `${timeoutSeconds} 秒內沒有回應會自動停止。`);

  const buttons = [{ id: 'continue', label: '繼續' }];
  // 7 天視窗不提供「到重置前不再問」（C6）。
  if (trigger.window === 'five_hour') buttons.push({ id: 'until_reset', label: '到重置前不再問' });
  buttons.push({ id: 'stop', label: '停止' });

  return {
    title: `usage-sentinel：用量即將用完${fake ? '（FAKE）' : ''}`,
    body: lines.join('\n'),
    buttons,
    defaultId: 'stop',
    timeoutSeconds,
  };
}
