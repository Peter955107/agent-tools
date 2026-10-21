<#
.SYNOPSIS
Spawn a fresh agent in a new herdr pane, confirm it is ready for input, and log it to the ledger.

.DESCRIPTION
Splits -FromPane (default: the caller's pane) toward its longer side, starts the agent with an
explicit model, then polls the visible screen until the agent's input prompt appears. Prints one
JSON line {name, pane_id, model} on success; exits 1 with a reason otherwise. On failure the new
pane is left open so the lead can inspect it.

.EXAMPLE
pwsh -File spawn-agent.ps1 -Name w-1-2-a7f3 -Model claude-sonnet-5.5 -Change my-change -TaskId 1.2
#>
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9_-]{0,31}$')][string]$Name,
    [Parameter(Mandatory)][string]$Model,
    [Parameter(Mandatory)][string]$Change,
    [Parameter(Mandatory)][string]$TaskId,
    [ValidateSet('kiro')][string]$Kind = 'kiro',
    [string]$FromPane = $env:HERDR_PANE_ID,
    [string]$Cwd = (Get-Location).Path,
    [int]$ReadySeconds = 60
)
$ErrorActionPreference = 'Stop'
$herdr = $env:HERDR_BIN_PATH
if ($env:HERDR_ENV -ne '1' -or -not $herdr) { Write-Error 'Not running inside a herdr pane (HERDR_ENV != 1).'; exit 1 }
if ($Model -eq 'auto') { Write-Error 'Pass an explicit model; auto is not allowed.'; exit 1 }

function Invoke-Herdr { $out = & $herdr @args 2>&1 | Out-String; if ($LASTEXITCODE -ne 0) { throw "herdr $($args -join ' '): $out" }; $out | ConvertFrom-Json }

# Split toward the pane's longer side. Terminal cells are about twice as tall as they are wide.
$layout = (Invoke-Herdr pane layout --pane $FromPane).result.layout
$rect = ($layout.panes | Where-Object pane_id -eq $FromPane).rect
$direction = if ($rect.width / 2 -ge $rect.height) { 'right' } else { 'down' }
$pane = (Invoke-Herdr pane split $FromPane --direction $direction --cwd $Cwd --no-focus).result.pane.pane_id

$agentArgs = @('chat', '--trust-all-tools', '--model', $Model)
& $herdr agent start $Name --kind $Kind --pane $pane --timeout 90000 -- @agentArgs 2>&1 | Out-Null

# agent start can report idle while a dialog is on screen, so wait for the real input prompt.
$deadline = (Get-Date).AddSeconds($ReadySeconds)
$screen = ''
while ((Get-Date) -lt $deadline) {
    $screen = & $herdr agent read $Name --source visible 2>&1 | Out-String
    if ($screen -match 'ask a question or describe a task') { break }
    if ($screen -match 'Yes, I accept') { Write-Error "$Name ($pane) shows the trust-all-tools risk confirmation; chat.disableTrustAllConfirmation is not set. Ask the user."; exit 1 }
    Start-Sleep -Milliseconds 1000
}
if ($screen -notmatch 'ask a question or describe a task') { Write-Error "$Name ($pane) did not reach its input prompt within ${ReadySeconds}s. Last screen:`n$screen"; exit 1 }
if ($screen -notmatch [regex]::Escape($Model)) { Write-Error "$Name ($pane) is ready but its status line does not show model $Model."; exit 1 }

$herd = Join-Path $Cwd '.herd'
New-Item -ItemType Directory -Force $herd | Out-Null
Add-Content (Join-Path $herd "$Change.md") "$(Get-Date -Format 'yyyy-MM-dd HH:mm') $TaskId spawn $Name ($pane, $Model)"
[pscustomobject]@{ name = $Name; pane_id = $pane; model = $Model } | ConvertTo-Json -Compress
