<#
.SYNOPSIS
Spawn a fresh agent in a new herdr pane, confirm it is ready for input, and log it to the ledger.

.DESCRIPTION
Splits -FromPane (default: the caller's pane) toward its longer side, starts the agent (Kiro or
Claude Code) with an explicit model and effort and all tools trusted, then polls the visible screen
until the agent's input prompt appears. Both roles get full permissions so a reviewer can run the
CLI commands a worker wrote; what either changed is caught afterwards (guard-snapshot.ps1, and for
reviewers the commit taken before review). Prints one JSON line {name, pane_id, role, kind, model, effort}
on success; exits 1 with a reason otherwise. On failure the new pane is left open so the lead can inspect it.

.EXAMPLE
pwsh -File spawn-agent.ps1 -Name w-1-2-a7f3 -Role worker -Kind kiro -Model claude-sonnet-5.5 -Effort high -Reason "default" -Change my-change -TaskId 1.2
#>
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9_-]{0,31}$')][string]$Name,
    [Parameter(Mandatory)][ValidateSet('worker', 'reviewer')][string]$Role,
    [Parameter(Mandatory)][string]$Model,
    [Parameter(Mandatory)][ValidateSet('low', 'medium', 'high', 'xhigh', 'max')][string]$Effort,
    [Parameter(Mandatory)][string]$Reason,
    [Parameter(Mandatory)][string]$Change,
    [Parameter(Mandatory)][string]$TaskId,
    [ValidateSet('kiro', 'claude')][string]$Kind = 'kiro',
    [string]$FromPane = $env:HERDR_PANE_ID,
    [string]$Cwd = (Get-Location).Path,
    [int]$ReadySeconds = 60
)
$ErrorActionPreference = 'Stop'
$herdr = $env:HERDR_BIN_PATH
if ($env:HERDR_ENV -ne '1' -or -not $herdr) { Write-Error 'Not running inside a herdr pane (HERDR_ENV != 1).'; exit 1 }
if ($Model -eq 'auto') { Write-Error 'Pass an explicit model; auto is not allowed.'; exit 1 }
if ($Model -match '^claude-haiku-' -and $Effort -in 'low', 'medium') { Write-Error "$Model never runs below high effort (got $Effort)." ; exit 1 }

function Invoke-Herdr { $out = & $herdr @args 2>&1 | Out-String; if ($LASTEXITCODE -ne 0) { throw "herdr $($args -join ' '): $out" }; $out | ConvertFrom-Json }

# Split toward the pane's longer side. Terminal cells are about twice as tall as they are wide.
$layout = (Invoke-Herdr pane layout --pane $FromPane).result.layout
$rect = ($layout.panes | Where-Object pane_id -eq $FromPane).rect
$direction = if ($rect.width / 2 -ge $rect.height) { 'right' } else { 'down' }
$pane = (Invoke-Herdr pane split $FromPane --direction $direction --cwd $Cwd --no-focus).result.pane.pane_id

# Both roles run unattended with every tool trusted; the lead checks their changes afterwards.
if ($Kind -eq 'kiro') {
    $agentArgs = @('chat', '--trust-all-tools', '--model', $Model, '--effort', $Effort)
    $readyPattern = 'ask a question or describe a task'
} else {
    $agentArgs = @('--dangerously-skip-permissions', '--model', $Model, '--effort', $Effort)
    # shortcut: matched against Claude Code's idle footer, not tested here; adjust if a release changes it.
    $readyPattern = '\? for shortcuts'
}
& $herdr agent start $Name --kind $Kind --pane $pane --timeout 90000 -- @agentArgs 2>&1 | Out-Null

# agent start can report idle while a dialog is on screen, so wait for the real input prompt.
$deadline = (Get-Date).AddSeconds($ReadySeconds)
$screen = ''
while ((Get-Date) -lt $deadline) {
    $screen = & $herdr agent read $Name --source visible 2>&1 | Out-String
    if ($screen -match $readyPattern) { break }
    if ($screen -match 'Yes, I accept') { Write-Error "$Name ($pane) shows the full-permission risk confirmation (Kiro: chat.disableTrustAllConfirmation not set; Claude: bypass-permissions mode not yet accepted). Ask the user."; exit 1 }
    Start-Sleep -Milliseconds 1000
}
if ($screen -notmatch $readyPattern) { Write-Error "$Name ($pane) did not reach its input prompt within ${ReadySeconds}s. Last screen:`n$screen"; exit 1 }
# Claude Code's status line shows a display name, not the model ID, so only Kiro's is checked.
if ($Kind -eq 'kiro' -and $screen -notmatch [regex]::Escape($Model)) { Write-Error "$Name ($pane) is ready but its status line does not show model $Model."; exit 1 }

$herd = Join-Path $Cwd '.herd'
New-Item -ItemType Directory -Force $herd | Out-Null
Add-Content (Join-Path $herd "$Change.md") "$(Get-Date -Format 'yyyy-MM-dd HH:mm') $TaskId spawn $Name ($pane, $Role, $Kind, $Model, effort $Effort) — $Reason"
[pscustomobject]@{ name = $Name; pane_id = $pane; role = $Role; kind = $Kind; model = $Model; effort = $Effort } | ConvertTo-Json -Compress
