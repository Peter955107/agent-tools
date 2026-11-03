<#
.SYNOPSIS
Dispatch a brief to a spawned agent: confirm the agent exists, save the guard state, log, and prompt it.

.DESCRIPTION
Saves {role, snapshot, status, protected, todo} to .herd/guard/<nonce>.json for guard-check.ps1 (role
from the nonce: t… = worker, r… = reviewer), writes the dispatch ledger line, then sends the one-line
prompt that points at .herd/briefs/<nonce>.md. -Protected lists the spec/plan paths no agent may edit;
-Todo is the task list inside them that only the lead edits. Prints herdr's prompt result and exits with
its code; with -NoWait it returns as soon as the prompt is sent. Run from the repo root.

.EXAMPLE
pwsh -NoProfile -File dispatch.ps1 -Name w-3-a7f3 -Nonce t3-a7f3 -TaskId T3 -Change my-feature -Protected tasks -Todo tasks/todo.md
#>
param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][ValidatePattern('^[tr][0-9a-z-]+$')][string]$Nonce,
    [Parameter(Mandatory)][string]$TaskId,
    [Parameter(Mandatory)][string]$Change,
    [string[]]$Protected = @('tasks'),
    [string]$Todo = 'tasks/todo.md',
    [switch]$NoWait,
    [int]$TimeoutMs = 1800000
)
$ErrorActionPreference = 'Stop'
$herdr = $env:HERDR_BIN_PATH
$brief = ".herd/briefs/$Nonce.md"
if (-not (Test-Path $brief)) { Write-Error "Missing $brief."; exit 1 }
& $herdr agent get $Name 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "Agent $Name not found; read its pane to find out why before respawning."; exit 1 }

$Protected = @($Protected -split ',' | Where-Object { $_ })
New-Item -ItemType Directory -Force .herd/guard | Out-Null
[pscustomobject]@{
    role      = if ($Nonce[0] -eq 't') { 'worker' } else { 'reviewer' }
    snapshot  = & (Join-Path $PSScriptRoot 'guard-snapshot.ps1') -Briefs $brief -Protected ($Protected -join ',') -Todo $Todo | ConvertFrom-Json
    status    = @(git status --short --untracked-files=all)
    protected = $Protected
    todo      = $Todo
} | ConvertTo-Json -Depth 3 | Set-Content ".herd/guard/$Nonce.json"
Add-Content ".herd/$Change.md" "$(Get-Date -Format 'yyyy-MM-dd HH:mm') $TaskId $Nonce → $Name dispatched"

$prompt = "Read $brief and do what it says; the reporting rules are at the end."
if ($NoWait) { & $herdr agent prompt $Name $prompt } else { & $herdr agent prompt $Name $prompt --wait --timeout $TimeoutMs }
exit $LASTEXITCODE
