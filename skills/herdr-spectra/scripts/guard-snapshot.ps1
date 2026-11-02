<#
.SYNOPSIS
Snapshot what a worker must not change, so the lead can tell afterwards whether it did.

.DESCRIPTION
Workers and reviewers run with every tool trusted, which skips any profile deny rules, so their limits are
checked after the fact instead. Prints one JSON line {head, stash, spectra_sha, briefs_sha}:
the HEAD commit, the stash list, a fingerprint of every file under docs/spectra/ (tracked and
untracked) except tasks.md files, which the lead's own spectra task start/done edits, and a
fingerprint of the given brief files. Run it right before dispatch and again after the report;
any differing field is a rule break.

.EXAMPLE
pwsh -NoProfile -File guard-snapshot.ps1 -Briefs .herd/briefs/t6-2-dd70.md
#>
param([Parameter(Mandatory)][string[]]$Briefs)
$ErrorActionPreference = 'Stop'
$Briefs = @($Briefs -split ',' | Where-Object { $_ })

$sha = Join-Path $PSScriptRoot 'scope-sha.ps1'
$spectraFiles = @(git ls-files --cached --others --exclude-standard -- docs/spectra | Where-Object { $_ -notmatch '(^|/)tasks\.md$' })
[pscustomobject]@{
    head        = (git rev-parse HEAD)
    stash       = (@(git stash list) -join "`n")
    spectra_sha = if ($spectraFiles) { & $sha @spectraFiles } else { 'empty' }
    briefs_sha  = & $sha @Briefs
} | ConvertTo-Json -Compress
