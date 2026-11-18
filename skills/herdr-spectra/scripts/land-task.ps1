<#
.SYNOPSIS
Land one passed task on the branch as a single commit that carries a message with historical meaning.

.DESCRIPTION
Run after 4.6's `spectra task done`. Stages the task's scope files plus the change's tasks.md and refuses
unless the staged scope files are byte-for-byte the last reviewed snapshot (refs/herd/<change>/<task>/r<n>):
what lands is exactly what the reviewer saw. Refuses a subject that is not `<type>(<scope>): <title>`
(.gitmessage) or that only names bookkeeping (勾選, task/round numbers, herd(...)); the subject and body
say what changed and why. Appends the trailers `Spectra-Task: <change> <task>` and `Review-Rounds: <n>`.
Runs the normal `git commit`, so every hook runs. Writes "<time> <task> land <sha> (rounds <n>, snapshot <sha>)"
to the ledger (guard-check.ps1 accepts it) and prints {"commit","rounds","snapshot"}. Never pushes.
Run from the repo root.

.EXAMPLE
pwsh -NoProfile -File land-task.ps1 -Files src/a.py,tests/test_a.py -TaskId 1.2 -Change my-change `
  -Subject "feat(backend): /backend 指令可切換並記住每個聊天的 backend" -Body "原本 /backend 只回固定文字……"
#>
param(
    [Parameter(Mandatory)][string[]]$Files,
    [Parameter(Mandatory)][string]$TaskId,
    [Parameter(Mandatory)][string]$Change,
    [Parameter(Mandatory)][string]$Subject,
    [Parameter(Mandatory)][string]$Body
)
$ErrorActionPreference = 'Stop'
$Files = @($Files -split ',' | Where-Object { $_ })

if ($Subject -notmatch '^(feat|fix|docs|refactor|test|chore|ci)!?\([a-z0-9_-]+\): \S') {
    Write-Error 'Subject must be "<type>(<scope>): <title>" (see .gitmessage).'; exit 1
}
if ($Subject -match '勾選|round \d|^herd\(|task \d+(\.\d+)*\s*$|^\w+\([^)]*\): (task|tasks) \d') {
    Write-Error 'Subject names bookkeeping, not the change; say what the task changed for the reader.'; exit 1
}
if (-not $Body.Trim()) { Write-Error 'Body must say why (what + why, not how).'; exit 1 }

$refs = @(git for-each-ref --format='%(refname)' "refs/herd/$Change/$TaskId/")
if (-not $refs) { Write-Error "No snapshot for task $TaskId; run snapshot-round.ps1 first."; exit 1 }
$rounds = [int]($refs | ForEach-Object { [int]($_ -replace '.*/r', '') } | Measure-Object -Maximum).Maximum
$snap = git rev-parse "refs/herd/$Change/$TaskId/r$rounds"

if (git diff --cached --name-only) { Write-Error 'The index already has staged changes; unstage them or ask the user first.'; exit 1 }
$tasks = "docs/spectra/changes/$Change/tasks.md"
git add -A -- @Files $tasks
if ($LASTEXITCODE -ne 0) { Write-Error 'git add failed.'; exit 1 }
git diff --cached --quiet $snap -- @Files
if ($LASTEXITCODE -ne 0) {
    git reset -q -- @Files $tasks
    Write-Error "Scope files differ from the reviewed snapshot $snap (round $rounds); review the difference first."; exit 1
}

$msg = New-TemporaryFile
try {
    Set-Content -Path $msg -Encoding utf8NoBOM -Value "$Subject`n`n$($Body.Trim())`n`nSpectra-Task: $Change $TaskId`nReview-Rounds: $rounds"
    git commit -q -F $msg
    if ($LASTEXITCODE -ne 0) { git reset -q -- @Files $tasks; Write-Error 'git commit failed (hook?); unstaged again, fix the cause and rerun.'; exit 1 }
} finally { Remove-Item $msg -ErrorAction SilentlyContinue }

$sha = git rev-parse HEAD
Add-Content ".herd/$Change.md" "$(Get-Date -Format 'yyyy-MM-dd HH:mm') $TaskId land $sha (rounds $rounds, snapshot $snap)"
[pscustomobject]@{ commit = $sha; rounds = $rounds; snapshot = $snap } | ConvertTo-Json -Compress
