<#
.SYNOPSIS
Commit exactly one task's scope files before its review, and log the commit to the ledger.

.DESCRIPTION
Refuses when the index already holds staged changes (they would slip into the commit) or when the
given files have nothing to commit. Commits as "herd(<change>): task <id> round <n>", writes
"<time> <task> commit <sha> (round <n>, parent <sha>)" to the ledger (guard-check.ps1 reads it) and
prints {"commit","parent"}; round 1's parent is the task's review base. Never pushes. Run from the repo root.

.EXAMPLE
pwsh -NoProfile -File commit-task.ps1 -Files src/a.py,tests/test_a.py -TaskId 1.2 -Round 1 -Change my-change
#>
param(
    [Parameter(Mandatory)][string[]]$Files,
    [Parameter(Mandatory)][string]$TaskId,
    [Parameter(Mandatory)][int]$Round,
    [Parameter(Mandatory)][string]$Change
)
$ErrorActionPreference = 'Stop'
$Files = @($Files -split ',' | Where-Object { $_ })

if (git diff --cached --name-only) { Write-Error 'The index already has staged changes; unstage them or ask the user first.'; exit 1 }
$parent = git rev-parse HEAD
git add -- @Files
if ($LASTEXITCODE -ne 0) { Write-Error 'git add failed.'; exit 1 }
if (-not (git diff --cached --name-only)) { Write-Error 'Nothing to commit in the given files.'; exit 1 }
git commit -q -m "herd($Change): task $TaskId round $Round"
if ($LASTEXITCODE -ne 0) { Write-Error 'git commit failed (hook?); the files are still staged.'; exit 1 }

$sha = git rev-parse HEAD
Add-Content ".herd/$Change.md" "$(Get-Date -Format 'yyyy-MM-dd HH:mm') $TaskId commit $sha (round $Round, parent $parent)"
[pscustomobject]@{ commit = $sha; parent = $parent } | ConvertTo-Json -Compress
