// 由 notify.mjs 以脫離的子程序啟動：送出桌面 toast 與 webhook。任何失敗都安靜略過。
import { spawnSync } from 'node:child_process';
import { webhookRequest } from './notify.mjs';

const text = process.env.USAGE_SENTINEL_NOTIFY_TEXT ?? '';
const webhookUrl = process.env.USAGE_SENTINEL_NOTIFY_WEBHOOK;

// Windows PowerShell 5.1 內建的 WinRT toast，以 PowerShell 的 AppId 送出。文字經環境變數傳入。
const TOAST_SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText01)
[void]$xml.GetElementsByTagName('text').Item(0).AppendChild($xml.CreateTextNode($env:USAGE_SENTINEL_NOTIFY_TEXT))
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
`;

if (process.env.USAGE_SENTINEL_NOTIFY_DESKTOP === '1' && process.platform === 'win32') {
  try {
    spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(TOAST_SCRIPT, 'utf16le').toString('base64')],
      { stdio: 'ignore', timeout: 15000, windowsHide: true },
    );
  } catch {
    // toast 失敗時略過（FR-5）
  }
}

if (webhookUrl) {
  try {
    const { headers, body } = webhookRequest(webhookUrl, text);
    await fetch(webhookUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(3000) });
  } catch {
    // webhook 失敗時略過
  }
}
