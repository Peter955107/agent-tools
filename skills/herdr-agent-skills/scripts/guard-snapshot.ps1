<#
.SYNOPSIS
Snapshot what a worker must not change, so the lead can tell afterwards whether it did.

.DESCRIPTION
Workers and reviewers run with every tool trusted, which skips any profile deny rules, so their limits are
checked after the fact instead. Prints one JSON line {head, stash, plan_sha, briefs_sha}:
the HEAD commit, the stash list, a fingerprint of every file under the -Protected paths (spec, plan;
tracked and untracked) except -Todo, which the lead's own checkbox edits change, and a fingerprint
of the given brief files. Run it right before dispatch and again after the report; any differing
field is a rule break.

.EXAMPLE
pwsh -NoProfile -File guard-snapshot.ps1 -Briefs .herd/briefs/t6-dd70.md -Protected tasks,SPEC.md -Todo tasks/todo.md
#>
param(
    [Parameter(Mandatory)][string[]]$Briefs,
    [Parameter(Mandatory)][string[]]$Protected,
    [Parameter(Mandatory)][string]$Todo
)
$ErrorActionPreference = 'Stop'
$Briefs = @($Briefs -split ',' | Where-Object { $_ })
$Protected = @($Protected -split ',' | Where-Object { $_ })
$Todo = $Todo -replace '\\', '/'

$sha = Join-Path $PSScriptRoot 'scope-sha.ps1'
$planFiles = @(git ls-files --cached --others --exclude-standard -- @Protected | Where-Object { $_ -ne $Todo })
[pscustomobject]@{
    head       = (git rev-parse HEAD)
    stash      = (@(git stash list) -join "`n")
    plan_sha   = if ($planFiles) { & $sha @planFiles } else { 'empty' }
    briefs_sha = & $sha @Briefs
} | ConvertTo-Json -Compress
