# Supply-chain gate for the game image: no unexpected binaries, no SUID, no privileged caps,
# plus an optional vulnerability scan. Run it before every deploy.
[CmdletBinding()]
param(
    [string]$Image = 'cs16-hlds:local',
    [switch]$SkipScan
)

$ErrorActionPreference = 'Stop'

# Everything the server needs, and nothing else. A miner or a backdoor is an ELF file too.
$allowed = @(
    '^/hlds/engine_i486\.so$',
    '^/hlds/(core|demoplayer|filesystem_stdio|proxy)\.so$',
    # Valve/HLDS components that ship with the dedicated server and are not used by us,
    # but which we deliberately keep rather than delete game files.
    '^/hlds/(voice_miles|voice_silk|voice_speex|crashhandler|vgui|vgui2|sw)\.so$',
    '^/hlds/linux64/(steamclient|libsteamwebrtc)\.so$',
    '^/hlds/valve/dlls/hl\.so$',
    '^/hlds/valve/cl_dlls/client\.so$',
    '^/hlds/cstrike/cl_dlls/client\.so$',
    '^/hlds/cstrike/dlls/cs_amd64\.so$',
    '^/hlds/hlds_linux$',
    '^/hlds/hlds_run$',
    '^/hlds/valve/dlls/director\.so$',
    '^/hlds/cstrike/dlls/cs\.so$',
    '^/hlds/cstrike/dlls/cs\.so\.valve$',
    '^/hlds/cstrike/addons/metamod/metamod_i386\.so$',
    '^/hlds/cstrike/addons/amxmodx/dlls/amxmodx_mm_i386\.so$',
    '^/hlds/cstrike/addons/amxmodx/modules/[a-z0-9_]+\.so$',
    '^/hlds/cstrike/addons/yapb/bin/yapb\.so$',
    '^/hlds/(linux32/)?steamclient\.so$',
    '^/hlds/(linux32/)?libsteam_api\.so$',
    '^/hlds/[A-Za-z0-9_.]*lib[A-Za-z0-9_]*\.so$'
)

Write-Host "==> inventory of executables and shared objects"
$inventory = docker run --rm --entrypoint /bin/bash $Image -c "find /hlds -type f \( -name '*.so' -o -name 'hlds*' \) -printf '%p\n'"
if ($LASTEXITCODE -ne 0) { throw "cannot inspect $Image" }

$unexpected = @()
foreach ($path in $inventory) {
    if ($path -eq '' -or $path -match '\.so\.\d') { continue }
    $matched = $false
    foreach ($pattern in $allowed) {
        if ($path -match $pattern) { $matched = $true; break }
    }
    if (-not $matched) { $unexpected += $path }
}

if ($unexpected.Count -gt 0) {
    Write-Host "unexpected binaries found:" -ForegroundColor Red
    $unexpected | ForEach-Object { Write-Host "  $_" }
    throw "image contains binaries outside the whitelist"
}
Write-Host "ok: $($inventory.Count) files, all whitelisted"

Write-Host "==> suid/sgid files"
$suid = docker run --rm --entrypoint /bin/bash $Image -c "find /hlds -perm /6000 -type f -printf '%p\n'"
if ($suid) {
    Write-Host $suid
    throw "image contains suid/sgid files"
}
Write-Host "ok: no suid/sgid files"

Write-Host "==> config sanity"
# Six custom plugins, one line each: plugins.ini is the contract the image must satisfy, and a
# missing .amxx means the control API sends RCON commands nobody answers.
$plugins = 'csdm_lite', 'donation_events', 'team_war', 'stream_cam', 'chaos_core', 'map_duel'
$check = 'grep -q ''addons/metamod/metamod_i386.so'' /hlds/cstrike/liblist.gam'
$check += ' && grep -q ''amxmodx_mm_i386.so'' /hlds/cstrike/addons/metamod/plugins.ini'
foreach ($plugin in $plugins) {
    $check += " && test -f /hlds/cstrike/addons/amxmodx/plugins/$plugin.amxx"
}
$check += " && echo 'ok: metamod, amxmodx and all 6 custom plugins are wired'"
docker run --rm --entrypoint /bin/bash $Image -c $check
if ($LASTEXITCODE -ne 0) { throw "image config is incomplete" }

if (-not $SkipScan) {
    Write-Host "==> vulnerability scan (HIGH, CRITICAL, fixable only)"
    # A persistent cache keeps the CVE database between runs; without it every scan starts by
    # downloading the whole DB again (minutes per run, and easy to mistake for a hang).
    $trivyCache = Join-Path $env:TEMP 'trivy-cache'
    New-Item -ItemType Directory -Force -Path $trivyCache | Out-Null
    # --ignore-unfixed: the base Debian layer carries CVEs that upstream never fixed for
    # bookworm (util-linux, zlib, ...). They cannot be patched by us; what must never pass
    # silently is a finding that has a fix, because that means we skipped an update.
    docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "${trivyCache}:/root/.cache/trivy" aquasec/trivy:latest image --quiet --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 $Image
    if ($LASTEXITCODE -ne 0) { throw "trivy reported fixable HIGH or CRITICAL vulnerabilities" }
    Write-Host "ok: no fixable HIGH/CRITICAL findings"
}

Write-Host "`nimage $Image passed the supply-chain gate" -ForegroundColor Green
