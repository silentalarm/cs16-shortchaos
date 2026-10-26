# Builds the game image with every pinned component from infra/checksums.env.
# `--build-arg-file` is missing in older buildx builds, so the file is expanded here instead
# of being passed through; the values themselves are unchanged.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$checksums = Join-Path $PSScriptRoot 'checksums.env'

$buildArgs = @('buildx', 'build', '-f', 'infra/Dockerfile', '-t', 'cs16-hlds:local')
foreach ($line in Get-Content $checksums) {
    if ($line -match '^\s*([A-Za-z0-9_]+)=(.*)$') {
        $buildArgs += '--build-arg'
        $buildArgs += "$($matches[1])=$($matches[2])"
    }
}
$buildArgs += '.'

Push-Location $root
try {
    # docker always writes its progress to stderr, and PowerShell 5.1 turns a native command's
    # stderr into a terminating error while $ErrorActionPreference is 'Stop'. Redirect it through
    # Write-Host and rely on the exit code instead of on the error stream.
    $ErrorActionPreference = 'Continue'
    docker @buildArgs 2>&1 | Write-Host
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
