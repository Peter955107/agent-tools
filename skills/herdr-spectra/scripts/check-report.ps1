<#
.SYNOPSIS
Check a worker or reviewer report against its schema and against the current scope files.

.DESCRIPTION
Fails when the file is missing or not JSON, does not match schemas/<kind>-report.schema.json,
names a different nonce than its file name, carries a scope_sha that no longer matches the scope
files (stale report), or - for a re-review - leaves out any of -PriorIds. A blocked worker report
must carry blocked_question. Prints one JSON line {ok, errors}; exits 1 when not ok.

.EXAMPLE
pwsh -NoProfile -File check-report.ps1 -Path .herd/results/r6-2-13cd.json -Kind review -Files script_sdk/env_file.py,tests/test_script_contracts.py -PriorIds F1,F2
#>
param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][ValidateSet('worker', 'review')][string]$Kind,
    [Parameter(Mandatory)][string[]]$Files,
    [string[]]$PriorIds = @()
)
$ErrorActionPreference = 'Stop'
# pwsh -File passes "a,b" as one string, so split list arguments ourselves.
$Files = @($Files -split ',' | Where-Object { $_ })
$PriorIds = @($PriorIds -split ',' | Where-Object { $_ })
$errors = [Collections.Generic.List[string]]::new()

function Out-Result { [pscustomobject]@{ ok = $errors.Count -eq 0; errors = $errors } | ConvertTo-Json -Compress; exit ([int]($errors.Count -ne 0)) }

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { $errors.Add("report not found: $Path"); Out-Result }
$raw = Get-Content -LiteralPath $Path -Raw -Encoding utf8
$schema = Get-Content -LiteralPath (Join-Path $PSScriptRoot "../schemas/$Kind-report.schema.json") -Raw -Encoding utf8
$schemaErrors = $null
if (-not ($raw | Test-Json -Schema $schema -ErrorAction SilentlyContinue -ErrorVariable schemaErrors)) {
    $schemaErrors | ForEach-Object { $errors.Add($_.Exception.Message) }
    if ($errors.Count -eq 0) { $errors.Add('report is not valid JSON') }
    Out-Result
}
$report = $raw | ConvertFrom-Json

$nonce = [IO.Path]::GetFileNameWithoutExtension($Path)
if ($report.nonce -ne $nonce) { $errors.Add("nonce '$($report.nonce)' does not match file name '$nonce'") }

$current = & (Join-Path $PSScriptRoot 'scope-sha.ps1') @Files
if ($report.scope_sha -ne $current) { $errors.Add("stale: scope_sha $($report.scope_sha) != current $current") }

if ($Kind -eq 'worker' -and $report.status -eq 'blocked' -and -not $report.blocked_question) { $errors.Add('status blocked without blocked_question') }
if ($Kind -eq 'review') {
    $answered = @($report.prior | ForEach-Object id)
    $PriorIds | Where-Object { $_ -notin $answered } | ForEach-Object { $errors.Add("prior finding $_ not answered") }
}
Out-Result
