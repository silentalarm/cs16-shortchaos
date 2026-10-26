# Wrapper around docker compose.
#
# The compose file lives in infra/, and compose looks for the environment file next to the compose
# file (or in the current directory), not next to the repository root where it actually is. Passing
# it explicitly is the whole reason this wrapper exists:
#
#   ./infra/compose.ps1 up -d hlds
#   ./infra/compose.ps1 --profile local-view up -d mediamtx
#   ./infra/compose.ps1 logs -f hlds
#
# No param() block on purpose: it keeps $args verbatim, so switches like -d and --profile reach
# docker unchanged instead of being parsed as PowerShell parameters.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
$composeFile = Join-Path $PSScriptRoot 'docker-compose.yml'

if (-not (Test-Path $envFile)) {
    throw "missing $envFile - copy .env.example to it and fill in RCON_PASSWORD and ADMIN_TOKEN"
}

Push-Location $root
try {
    # docker writes its progress and pull output to stderr; PowerShell 5.1 turns that into a
    # terminating error while the preference is 'Stop', so it is relaxed here and the exit code
    # is what callers should trust.
    $ErrorActionPreference = 'Continue'
    docker compose --env-file $envFile -f $composeFile @args 2>&1 | Write-Host
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
