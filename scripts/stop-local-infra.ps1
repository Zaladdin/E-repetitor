# Stops only the portable runtimes belonging to this checkout. Keeps all data.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$pgCtl = Join-Path $projectRoot '.local/pgsql/bin/pg_ctl.exe'
$dataDir = Join-Path $projectRoot '.local/pgdata'
$mailpit = Join-Path $projectRoot '.local/mailpit/mailpit.exe'
if (Test-Path -LiteralPath $pgCtl) {
    & $pgCtl -D $dataDir status *> $null
    if ($LASTEXITCODE -eq 0) {
        & $pgCtl -D $dataDir -m fast -w stop
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL did not stop cleanly.' }
    }
}
Get-Process -Name mailpit -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $mailpit } | Stop-Process
Write-Host 'Portable services stopped; database and captured mail remain in .local/.'
