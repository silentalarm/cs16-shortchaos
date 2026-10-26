# Builds the autonomous capture image (infra/stream/Dockerfile) with the pinned Xash3D and
# CS16Client archives from infra/checksums.env. Same --build-arg expansion as build-image.ps1.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$checksums = Join-Path $PSScriptRoot 'checksums.env'

$wanted = @('XASH3D_URL', 'XASH3D_SHA256', 'CS16CLIENT_URL', 'CS16CLIENT_SHA256')
$values = @{}
foreach ($line in Get-Content $checksums) {
    if ($line -match '^\s*([A-Za-z0-9_]+)=(.*)$' -and $wanted -contains $matches[1]) {
        $values[$matches[1]] = $matches[2]
    }
}
foreach ($key in $wanted) {
    if (-not $values.ContainsKey($key)) {
        throw "$key is missing from infra/checksums.env - run infra/update-checksums.ps1 first"
    }
}

$buildArgs = @(
    'buildx', 'build', '-f', 'infra/stream/Dockerfile', '-t', 'cs16-stream:local',
    '--build-arg', "XASH_URL=$($values['XASH3D_URL'])",
    '--build-arg', "XASH_SHA256=$($values['XASH3D_SHA256'])",
    '--build-arg', "CS16CLIENT_URL=$($values['CS16CLIENT_URL'])",
    '--build-arg', "CS16CLIENT_SHA256=$($values['CS16CLIENT_SHA256'])",
    '.'
)

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
