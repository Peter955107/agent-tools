<#
.SYNOPSIS
Compare the guard state saved by dispatch.ps1 with the current one and list every rule break.

.DESCRIPTION
Flags: a changed stash list; a HEAD that was reset/rewritten or gained a commit the ledger does not list
(the lead's commit-task.ps1 commits are listed); changes under docs/spectra/ other than tasks.md; an
edited brief; and new or changed `git status` lines — for a worker only paths outside -Scope, for a
reviewer any path. Paths under .herd/ and in -Ignore (e.g. parallel workers' files) are skipped.
Prints {"ok":true} or {"ok":false,"issues":[…]} and exits 1 when not ok. Run from the repo root.

.EXAMPLE
pwsh -NoProfile -File guard-check.ps1 -Nonce t1-2-a7f3 -Change my-change -Scope src/a.py,tests/test_a.py
#>
param(
    [Parameter(Mandatory)][string]$Nonce,
    [Parameter(Mandatory)][string]$Change,
    [string[]]$Scope = @(),
    [string[]]$Ignore = @()
)
$ErrorActionPreference = 'Stop'
$Scope = @($Scope -split ',' | Where-Object { $_ })
$Ignore = @($Ignore -split ',' | Where-Object { $_ })

$saved = Get-Content ".herd/guard/$Nonce.json" -Raw | ConvertFrom-Json
$old = $saved.snapshot
$new = & (Join-Path $PSScriptRoot 'guard-snapshot.ps1') -Briefs ".herd/briefs/$Nonce.md" | ConvertFrom-Json
$issues = [System.Collections.Generic.List[string]]::new()

if ($new.stash -ne $old.stash) { $issues.Add('stash list changed') }
if ($new.head -ne $old.head) {
    git merge-base --is-ancestor $old.head $new.head
    if ($LASTEXITCODE -ne 0) { $issues.Add("HEAD moved off $($old.head) (reset or rewrite)") }
    else {
        $logged = @(Select-String -Path ".herd/$Change.md" -Pattern ' commit ([0-9a-f]{40}) ' | ForEach-Object { $_.Matches[0].Groups[1].Value })
        foreach ($c in @(git rev-list "$($old.head)..$($new.head)")) { if ($c -notin $logged) { $issues.Add("commit $c is not in the ledger") } }
    }
}
if ($new.spectra_sha -ne $old.spectra_sha) { $issues.Add('docs/spectra/ changed outside tasks.md') }
if ($new.briefs_sha -ne $old.briefs_sha) { $issues.Add(".herd/briefs/$Nonce.md was edited") }

# shortcut: compares status lines, so a further edit to a file that was already dirty before dispatch goes unnoticed; hash such files if that matters.
$before = @($saved.status)
foreach ($line in @(git status --short --untracked-files=all)) {
    if ($line -in $before) { continue }
    $path = ($line.Substring(3) -split ' -> ')[-1].Trim('"')
    if ($path.StartsWith('.herd/') -or ($Ignore | Where-Object { $path -eq $_ -or $path.StartsWith("$_/") })) { continue }
    if ($saved.role -eq 'worker' -and $path -in $Scope) { continue }
    $issues.Add("changed outside scope: $line")
}

if ($issues.Count) { [pscustomobject]@{ ok = $false; issues = @($issues) } | ConvertTo-Json -Compress; exit 1 }
'{"ok":true}'
