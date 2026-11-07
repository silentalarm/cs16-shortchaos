# Fetches the custom arena maps listed in infra/maps/maps.json from GameBanana.
#
# Why a host-side script and not a Dockerfile step: the image stays hermetic (nothing is downloaded
# during a build, so an upstream change cannot slip an unreviewed binary into the image silently).
# The file is pinned by SHA256 in maps.json - the first run with -Pin records the hash, every later
# run refuses a file that does not match it, and GameBanana's own MD5 plus its AV verdict are checked
# on the way in.
#
# Usage:
#   ./infra/fetch-maps.ps1              # fetch what is missing, verify the pins
#   ./infra/fetch-maps.ps1 -Pin         # fetch and record the hashes of new files (review first!)
#   ./infra/fetch-maps.ps1 -Only fy_iceworld -Force
[CmdletBinding()]
param(
    [string[]] $Only = @(),
    [switch] $Pin,
    [switch] $Force
)

$ErrorActionPreference = 'Stop'

$dir = $PSScriptRoot
$mapsDir = Join-Path $dir 'maps'
$manifestPath = Join-Path $mapsDir 'maps.json'
$api = 'https://api.gamebanana.com/Core/Item/Data?itemtype=Mod&itemid={0}&fields=Files().aFiles()'
$headers = @{ 'User-Agent' = 'cs16-shortchaos map fetcher (+https://github.com/silentalarm/cs16-shortchaos)' }

if (-not (Test-Path $manifestPath)) { throw "missing $manifestPath" }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("cs16-maps-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

# Newest file row of a mod: GameBanana keeps old versions attached to the same page.
function Get-NewestFile($modId) {
    $rows = Invoke-RestMethod -Uri ($api -f $modId) -Headers $headers -TimeoutSec 60
    $files = @()
    foreach ($row in @($rows)) {
        if ($null -eq $row) { continue }
        foreach ($property in $row.PSObject.Properties) { $files += $property.Value }
    }
    if ($files.Count -eq 0) { throw "mod $modId has no files" }
    return $files | Sort-Object -Property _tsDateAdded -Descending | Select-Object -First 1
}

function Expand-ArchiveTo($archive, $target) {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($null -ne $tar) {
        # bsdtar reads zip and rar and is present on Windows 10+; it beats Expand-Archive, which is
        # zip-only, and a good part of the CS 1.6 map packs on GameBanana are .rar.
        & $tar.Source -xf $archive -C $target 2>$null
        if ($LASTEXITCODE -eq 0) { return $true }
    }
    if ($archive -like '*.zip') { Expand-Archive -Path $archive -DestinationPath $target -Force; return $true }
    return $false
}

$failures = 0
$pinned = $false

foreach ($entry in $manifest.maps) {
    if ($Only.Count -gt 0 -and $Only -notcontains $entry.name) { continue }

    $bsp = Join-Path $mapsDir ($entry.name + '.bsp')
    if ((Test-Path $bsp) -and -not $Force) {
        Write-Host ("{0}: already present" -f $entry.name)
        continue
    }

    # A map that is not on GameBanana (aim_aspect came from DS-Servers by hand) has no `mod`: there is
    # nothing to fetch and nothing to verify against an archive, so the reviewed .bsp in git is the
    # source of truth and this loop leaves it alone.
    if ($null -eq $entry.mod) {
        Write-Host ("{0}: hand-added, not fetched (no GameBanana mod id)" -f $entry.name)
        continue
    }

    try {
        $file = Get-NewestFile $entry.mod
        Write-Host ("{0}: {1} ({2} KB, {3})" -f $entry.name, $file._sFile, [int]($file._nFilesize / 1KB), $file._sDownloadUrl)

        if ($file._sAvResult -and $file._sAvResult -ne 'clean') { throw "GameBanana AV verdict is '$($file._sAvResult)'" }
        if ($file._sAnalysisResult -and $file._sAnalysisResult -ne 'ok') { throw "GameBanana analysis is '$($file._sAnalysisResult)'" }

        $archive = Join-Path $temp $file._sFile
        Invoke-WebRequest -Uri $file._sDownloadUrl -OutFile $archive -Headers $headers -UseBasicParsing -TimeoutSec 300

        if ($file._sMd5Checksum) {
            $md5 = (Get-FileHash -Path $archive -Algorithm MD5).Hash.ToLower()
            if ($md5 -ne $file._sMd5Checksum.ToLower()) {
                throw "MD5 mismatch: GameBanana published $($file._sMd5Checksum), got $md5"
            }
        }

        $sha = (Get-FileHash -Path $archive -Algorithm SHA256).Hash.ToLower()
        if ([string]::IsNullOrWhiteSpace($entry.sha256)) {
            if (-not $Pin) { throw "no sha256 pin recorded - review the file, then run with -Pin (hash $sha)" }
            $entry.sha256 = $sha
            $pinned = $true
            Write-Host ("{0}: pinned {1}" -f $entry.name, $sha)
        }
        elseif ($sha -ne $entry.sha256.ToLower()) {
            throw "SHA256 mismatch: pinned $($entry.sha256), got $sha - the upload changed, review it before pinning again"
        }

        $extracted = Join-Path $temp ($entry.name + '-x')
        if (-not (Expand-ArchiveTo $archive $extracted)) {
            throw "cannot unpack $($file._sFile) (rar needs tar.exe from Windows 10+): extract it by hand into infra/maps"
        }

        # Interpolation, not `@($entry.name + '.bsp', ...)`: PowerShell parses that as one string with
        # the comma swallowed, and then every file looks like a mismatch.
        # Resources matter as much as the map itself: fy_iceworld aborts the server with
        # "TEX_InitFromWad: couldn't open de_vegas.wad" when only the .bsp is copied.
        $wanted = @(
            "$($entry.name).bsp", "$($entry.name).res", "$($entry.name).nav", "$($entry.name).txt",
            "$($entry.name).wad", 'de_vegas.wad'
        )
        $copied = 0
        foreach ($path in Get-ChildItem -Path $extracted -Recurse -File) {
            # Sound, sprites and models travel with a map pack as often as a wad does.
            if ($wanted -notcontains $path.Name.ToLower() -and $path.Extension -notin @('.wad', '.wav', '.mp3', '.spr', '.mdl')) {
                continue
            }
            # Map files are lower-cased: one pack ships "fy_Dustworld.bsp", and on Linux the engine
            # looks for exactly the name the rotation asks for. Resources keep their own case - the
            # .bsp refers to them by name.
            $name = $path.Name
            if ($path.Extension -in @('.bsp', '.res', '.nav', '.txt')) { $name = $name.ToLower() }
            Copy-Item -Path $path.FullName -Destination (Join-Path $mapsDir $name) -Force
            $copied++
        }
        if ($copied -eq 0 -or -not (Test-Path $bsp)) {
            $found = (Get-ChildItem -Path $extracted -Recurse -File -Filter '*.bsp' | ForEach-Object { $_.Name }) -join ', '
            throw "the archive does not contain $($entry.name).bsp (found: $found)"
        }
        Write-Host ("{0}: installed {1} file(s)" -f $entry.name, $copied)
    }
    catch {
        $failures++
        [Console]::Error.WriteLine(("{0}: FAILED - {1}" -f $entry.name, $_.Exception.Message))
    }
}


Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue

if ($pinned) {
    # Re-serialised whole: the pins are the point of this file, so the rewrite is not cosmetic.
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -Path $manifestPath -Encoding UTF8
    Write-Host 'maps.json updated with new pins - review the diff before committing'
}

if ($failures -gt 0) {
    [Console]::Error.WriteLine("$failures map(s) failed")
    exit 1
}

Write-Host @'
Maps are in infra/maps; `./infra/compose.ps1 restart hlds` copies them into the server at start.
A new map also has to join the rotation: `map_duel_maps` in plugins/map_duel/map_duel.sma and
`params.maps` of the map_change activity in config/activities.json (test/map-duel-contract.test.ts
fails when the two disagree).
'@
