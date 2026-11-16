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
$script:defaultButton = $null
$labels = $env:USAGE_SENTINEL_DIALOG_BUTTONS -split "\`n"
$defaultIndex = [int]$env:USAGE_SENTINEL_DIALOG_DEFAULT
for ($i = 0; $i -lt $labels.Count; $i++) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $labels[$i]
  $button.AutoSize = $true
  $button.Tag = $i
  $button.Add_Click({ $script:choice = $this.Tag; $form.Close() })
  $row.Controls.Add($button)
  if ($i -eq $defaultIndex) { $form.AcceptButton = $button; $script:defaultButton = $button }
}
$layout.Controls.Add($row)
$form.Controls.Add($layout)
# 按鈕要等視窗顯示後才能取得焦點；在加入視窗前設定 ActiveControl 會丟出例外。
$form.Add_Shown({ $form.Activate(); if ($script:defaultButton) { [void]$script:defaultButton.Focus() } })
if ($env:USAGE_SENTINEL_DIALOG_SELFTEST -eq '1') { [Console]::Out.Write('selftest'); exit 0 }
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

// PowerShell 把錯誤以 CLIXML 寫到 stderr（A14），取出可讀的錯誤訊息。
function powershellErrors(stderr) {
  const errors = [...stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1].replace(/_x000D__x000A_/g, ' ').trim());
  const text = errors.length ? errors.filter(Boolean).join(' ') : stderr.replace('#< CLIXML', '').trim();
  return text.slice(0, 500);
}

// 回傳 { choice, elapsedMs, detail? }。choice 為按鈕 id，或 'dismissed'（關閉視窗）、'timeout'、'unavailable'；
// unavailable 時 detail 說明原因。
export function showDialog(spec, { platform = process.platform, launch, onSpawn } = {}) {
  const started = Date.now();
  const done = (choice, detail) => ({ choice, elapsedMs: Date.now() - started, ...(detail && { detail }) });
  if (!launch) {
    if (platform !== 'win32') return Promise.resolve(done('unavailable')); // macOS／Linux 見任務 16
    launch = powershellLaunch;
  }
  const { command, args, env } = launch(spec);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(done(choice, detail));
    };

    let child;
    try {
      child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    } catch (error) {
      resolve(done('unavailable', error.code || error.message));
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish('timeout');
    }, spec.timeoutSeconds * 1000);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('spawn', () => onSpawn?.(child.pid));
    child.on('error', (error) => finish('unavailable', error.code || error.message));
    child.on('close', (code) => {
      const trimmed = stdout.trim();
      if (trimmed === 'selftest') return finish('selftest');
      if (!/^-?\d+$/.test(trimmed)) {
        const errors = powershellErrors(stderr);
        return finish('unavailable', `exit ${code}${errors ? `：${errors}` : ''}`);
      }
      const index = Number(trimmed);
      if (index === -1) return finish('dismissed');
      finish(spec.buttons[index]?.id ?? 'unavailable', `未知的按鈕索引 ${index}`);
    });
  });
}

// 測試用替身：USAGE_SENTINEL_DIALOG_STUB=「選擇[:延遲毫秒]」，只在設了 USAGE_SENTINEL_DIR 時生效。
export function dialogFor(env) {
  const stub = env.USAGE_SENTINEL_DIR && env.USAGE_SENTINEL_DIALOG_STUB;
  if (!stub) return showDialog;
  const [choice, delay = '0'] = stub.split(':');
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, Number(delay)));
    return { choice, elapsedMs: Number(delay), ...(choice === 'unavailable' && { detail: 'stub' }) };
  };
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
