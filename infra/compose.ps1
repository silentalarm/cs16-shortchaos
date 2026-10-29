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
    # `dev` is the cheap mode: the game server and the panel without the capture client. The client is
    # the expensive part of the stack - it renders on llvmpipe (software OpenGL) and holds ~1.6 cores
    # no matter how small the picture is, while the encoder costs 0.4-0.7. `live` brings the client back.
    if ($args.Count -ge 1 -and $args[0] -eq 'dev') {
        $rest = @()
        if ($args.Count -gt 1) { $rest = $args[1..($args.Count - 1)] }
        $ErrorActionPreference = 'Continue'
        # Stop the capture client first: with it running there is no point starting anything else,
        # and `--scale stream=0` is not allowed next to an explicit service list.
        docker compose --env-file $envFile -f $composeFile stop stream 2>&1 | Write-Host
        docker compose --env-file $envFile -f $composeFile up -d hlds control-api @rest 2>&1 | Write-Host
        exit $LASTEXITCODE
    }

    # docker writes its progress and pull output to stderr; PowerShell 5.1 turns that into a
    # terminating error while the preference is 'Stop', so it is relaxed here and the exit code
    # is what callers should trust.
    $ErrorActionPreference = 'Continue'
    docker compose --env-file $envFile -f $composeFile @args 2>&1 | Write-Host
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
