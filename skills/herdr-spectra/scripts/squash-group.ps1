<#
.SYNOPSIS
Squash one finished task group's per-round commits into a single commit, and log it to the ledger.

.DESCRIPTION
Finds the group's commits in the ledger ("<time> <G>.<n> commit <sha> ..."), takes the first one's parent
as the group base, and refuses unless base..HEAD holds exactly the ledger commits of that group (no
interleaved commits from other groups or the user) and the index is clean. Then `git reset --soft <base>`
and one commit with -Message. Unstaged and untracked files are left alone. Writes
"<time> group <G> squash <sha> (base <sha>, was <old head>, <n> commits)" to the ledger; the old head stays
reachable through that line and the reflog. Never pushes. Run from the repo root, only when no task is in flight.

.EXAMPLE
pwsh -NoProfile -File squash-group.ps1 -Group 3 -Change my-change -Message "herd(my-change): 3. Parser"
#>
param(
    [Parameter(Mandatory)][string]$Group,
    [Parameter(Mandatory)][string]$Change,
    [Parameter(Mandatory)][string]$Message
)
$ErrorActionPreference = 'Stop'
$ledger = ".herd/$Change.md"

$lines = @(Select-String -Path $ledger -Pattern "^\S+ \S+ $([regex]::Escape($Group))\.\S+ commit ([0-9a-f]{40}) \(round \d+, parent ([0-9a-f]{40})\)")
if (-not $lines) { Write-Error "No commits for group $Group in $ledger."; exit 1 }
$mine = @($lines | ForEach-Object { $_.Matches[0].Groups[1].Value })
$base = $lines[0].Matches[0].Groups[2].Value

$range = @(git rev-list "$base..HEAD")
if ($LASTEXITCODE -ne 0) { Write-Error "Base $base is not an ancestor of HEAD."; exit 1 }
$foreign = @($range | Where-Object { $_ -notin $mine })
$missing = @($mine | Where-Object { $_ -notin $range })
if ($foreign -or $missing) {
    Write-Error "base..HEAD is not exactly group $Group's commits (foreign: $($foreign -join ', '); missing: $($missing -join ', ')). Leave them as they are and tell the user."
    exit 1
}
if ($range.Count -lt 2) { Write-Output "Group $Group has $($range.Count) commit; nothing to squash."; exit 0 }
if (git diff --cached --name-only) { Write-Error 'The index already has staged changes; unstage them or ask the user first.'; exit 1 }

$old = git rev-parse HEAD
git reset -q --soft $base
git commit -q -m $Message
if ($LASTEXITCODE -ne 0) { git reset -q --soft $old; Write-Error "git commit failed (hook?); HEAD restored to $old."; exit 1 }

$sha = git rev-parse HEAD
if ((git rev-parse "$sha^{tree}") -ne (git rev-parse "$old^{tree}")) { Write-Error "Tree differs from $old; inspect before continuing."; exit 1 }
Add-Content $ledger "$(Get-Date -Format 'yyyy-MM-dd HH:mm') group $Group squash $sha (base $base, was $old, $($range.Count) commits)"
[pscustomobject]@{ commit = $sha; base = $base; was = $old; squashed = $range.Count } | ConvertTo-Json -Compress
