<#
.SYNOPSIS
Print a 12-hex fingerprint of a task's scope files, so a report can be matched to the tree it describes.

.DESCRIPTION
Hashes each file's bytes (a missing file counts as deleted), sorted by path, then hashes that list.
The order the paths are given in does not matter. Workers, reviewers and the lead run the same
command with the brief's scope list; differing output means the files changed in between.

.EXAMPLE
pwsh -NoProfile -File .claude/skills/herdr-spectra/scripts/scope-sha.ps1 script_sdk/env_file.py tests/test_script_contracts.py
#>
param([Parameter(Mandatory, ValueFromRemainingArguments)][string[]]$Files)
$ErrorActionPreference = 'Stop'

$lines = $Files | ForEach-Object { $_ -replace '\\', '/' } | Sort-Object -Unique -CaseSensitive | ForEach-Object {
    $hash = if (Test-Path -LiteralPath $_ -PathType Leaf) { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash } else { 'deleted' }
    "$_`t$hash"
}
$bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).Substring(0, 12).ToLower()
