<#
.SYNOPSIS
Freeze one round of a task's scope files as a side ref before its review, without moving HEAD.

.DESCRIPTION
Builds a commit object in a temporary index (the real index and HEAD are untouched): round 1 starts from
HEAD, which becomes the task's review base; round n starts from round n-1, so `git diff <base> <ref>` only
ever shows this task's files even when other tasks land in between. Stores it at
refs/herd/<change>/<task>/r<n> (refuses to overwrite), writes
"<time> <task> snapshot <sha> (round <n>, parent <sha>)" to the ledger and prints {"commit","parent","ref"}.
Hooks do not run here; land-task.ps1 runs them on the one commit that reaches the branch. Never pushes.
Run from the repo root.

.EXAMPLE
pwsh -NoProfile -File snapshot-round.ps1 -Files src/a.py,tests/test_a.py -TaskId 1.2 -Round 1 -Change my-change
#>
param(
    [Parameter(Mandatory)][string[]]$Files,
    [Parameter(Mandatory)][string]$TaskId,
    [Parameter(Mandatory)][int]$Round,
    [Parameter(Mandatory)][string]$Change
)
$ErrorActionPreference = 'Stop'
$Files = @($Files -split ',' | Where-Object { $_ })
$ref = "refs/herd/$Change/$TaskId/r$Round"

git rev-parse -q --verify $ref *> $null
if ($LASTEXITCODE -eq 0) { Write-Error "$ref already exists; use the next round number."; exit 1 }
if ($Round -eq 1) { $parent = git rev-parse HEAD }
else {
    $parent = git rev-parse -q --verify "refs/herd/$Change/$TaskId/r$($Round - 1)"
    if ($LASTEXITCODE -ne 0) { Write-Error "Round $($Round - 1) has no snapshot."; exit 1 }
}

$tmp = New-TemporaryFile
$saved = $env:GIT_INDEX_FILE
try {
    $env:GIT_INDEX_FILE = $tmp.FullName
    git read-tree $parent
    git add -A -- @Files
    if ($LASTEXITCODE -ne 0) { Write-Error 'git add failed.'; exit 1 }
    $tree = git write-tree
} finally { $env:GIT_INDEX_FILE = $saved; Remove-Item $tmp -ErrorAction SilentlyContinue }

if ($tree -eq (git rev-parse "$parent^{tree}")) { Write-Error 'Nothing changed in the given files since the parent.'; exit 1 }
$sha = git commit-tree $tree -p $parent -m "herd($Change): task $TaskId round $Round (snapshot)"
git update-ref $ref $sha ''
if ($LASTEXITCODE -ne 0) { Write-Error "update-ref $ref failed."; exit 1 }

Add-Content ".herd/$Change.md" "$(Get-Date -Format 'yyyy-MM-dd HH:mm') $TaskId snapshot $sha (round $Round, parent $parent)"
[pscustomobject]@{ commit = $sha; parent = $parent; ref = $ref } | ConvertTo-Json -Compress
