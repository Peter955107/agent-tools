<#
.SYNOPSIS
Close a pane that spawn-agent.ps1 opened, once its agent is idle, and log it to the ledger.

.DESCRIPTION
Refuses to close anything the ledger does not record as spawned by this skill, so the user's own
panes are never touched. Refuses while the agent is working or blocked.

.EXAMPLE
pwsh -File close-agent.ps1 -Name w-1-2-a7f3 -Change my-change
#>
param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Change,
    [string]$Cwd = (Get-Location).Path
)
$ErrorActionPreference = 'Stop'
$herdr = $env:HERDR_BIN_PATH
$ledger = Join-Path $Cwd ".herd/$Change.md"

$agent = (& $herdr agent get $Name 2>&1 | Out-String | ConvertFrom-Json).result.agent
if (-not $agent) { Write-Error "Agent $Name not found; inspect the panes before closing anything."; exit 1 }
$pane = $agent.pane_id

$spawned = (Test-Path $ledger) -and (Select-String -Path $ledger -SimpleMatch "spawn $Name ($pane," -Quiet)
if (-not $spawned) { Write-Error "Ledger has no 'spawn $Name ($pane, ...' line; not closing a pane this skill did not open."; exit 1 }
if ($agent.agent_status -notin 'idle', 'done') { Write-Error "$Name is $($agent.agent_status); close it only when idle or done."; exit 1 }

& $herdr pane close $pane 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "herdr pane close $pane failed."; exit 1 }
Add-Content $ledger "$(Get-Date -Format 'yyyy-MM-dd HH:mm') close $Name ($pane)"
"closed $Name ($pane)"
