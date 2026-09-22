# Starts the portable development runtimes already prepared in this checkout.
# For a fresh checkout, use compose.yml; this script downloads/installs nothing.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$pgCtl = Join-Path $projectRoot '.local/pgsql/bin/pg_ctl.exe'
$dataDir = Join-Path $projectRoot '.local/pgdata'
$mailpit = Join-Path $projectRoot '.local/mailpit/mailpit.exe'
if (-not (Test-Path -LiteralPath $pgCtl) -or -not (Test-Path -LiteralPath (Join-Path $dataDir 'PG_VERSION')) -or -not (Test-Path -LiteralPath $mailpit)) {
    throw 'Portable runtimes are not initialized. Use the Docker setup in docs/ACCOUNTS.md.'
}
& $pgCtl -D $dataDir status *> $null
if ($LASTEXITCODE -ne 0) {
    & $pgCtl -D $dataDir -l (Join-Path $projectRoot '.local/postgres.log') -w start
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL failed to start. See .local/postgres.log.' }
}
$smtpListener = Get-NetTCPConnection -LocalPort 1025 -State Listen -ErrorAction SilentlyContinue
if (-not $smtpListener) {
    Start-Process -FilePath $mailpit -ArgumentList '--listen 127.0.0.1:8025 --smtp 127.0.0.1:1025 --allowed-hosts 127.0.0.1,localhost --disable-version-check --block-remote-css-and-fonts --database .local/mailpit.db --log-file .local/mailpit.log' -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null
} else {
    $owner = Get-Process -Id $smtpListener[0].OwningProcess -ErrorAction Stop
    if ($owner.Path -ne $mailpit) { throw 'Port 1025 belongs to another process. It was left untouched.' }
}
Write-Host 'Local PostgreSQL: 127.0.0.1:55432. Mailpit: http://127.0.0.1:8025/'
