# Run explicitly as the plugin user. This script installs no service or task.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$StateDir,
      [Parameter(Mandatory)][string]$SshConfig,
      [switch]$Once)
$ErrorActionPreference = 'Stop'
$state = (Resolve-Path -LiteralPath $StateDir).Path
$config = (Resolve-Path -LiteralPath $SshConfig).Path
$helper = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../cloud/t3-sync-transfer.py')).Path
do {
  & python -I $helper $state --pump $config
  $code = $LASTEXITCODE
  if ($Once) { exit $code }
  if ($code -ne 0) { Write-Warning 'Relay unavailable; no claim or acknowledgement inferred.'; Start-Sleep -Seconds 2 }
  else { Start-Sleep -Milliseconds 300 }
} while ($true)
