# Gate for the capture image (infra/stream): expected binaries only, all libraries resolvable,
# plus an optional live smoke test that renders the client and encodes a few seconds to a file.
#
#   powershell -File infra/verify-stream.ps1                 # static checks only
#   powershell -File infra/verify-stream.ps1 -SmokeTest      # also run Xvfb + engine + ffmpeg
#
# The smoke test mounts two named volumes, because the container needs the game content read-only
# (/server, filled from the game-server image) and a writable copy for the engine (/game).
[CmdletBinding()]
param(
    [string]$Image = 'cs16-stream:local',
    [string]$ServerImage = 'cs16-hlds:local',
    [int]$SmokeTimeoutSec = 420,
    [switch]$SmokeTest
)

$ErrorActionPreference = 'Stop'

function Invoke-InImage {
    param([string]$Command)
    $out = docker run --rm --entrypoint /bin/bash $Image -c $Command 2>&1
    if ($LASTEXITCODE -ne 0) { throw "in-image command failed:`n$Command`n$out" }
    return $out
}

Write-Host '==> required binaries'
# Commands passed to `docker run -c` must avoid nested quotes: Windows PowerShell 5.1 drops them
# when it forwards an argument to a native command, and bash then fails with a syntax error.
# The engine is not on PATH: it lives in /opt/xash and is copied next to the game dirs at runtime.
$bins = Invoke-InImage 'test -x /opt/xash/xash3d || echo MISSING-xash3d; for b in ffmpeg ffprobe Xvfb tini; do command -v $b > /dev/null || echo MISSING-$b; done; echo checked'
$bins
if ($bins -match 'MISSING') { throw 'a required binary is missing from the image' }

Write-Host '==> engine libraries resolve'
$missing = Invoke-InImage "ldd /opt/xash/xash3d | grep -i 'not found' || echo none"
if ($missing -notmatch 'none') { throw "unresolved libraries: $missing" }
Write-Host '  all resolved'

Write-Host '==> X11 grab support in ffmpeg'
$grab = Invoke-InImage 'ffmpeg -hide_banner -devices 2>/dev/null | grep -c x11grab'
if ([int]$grab -lt 1) { throw 'ffmpeg was built without x11grab: capture is impossible' }
Write-Host '  x11grab present'

Write-Host '==> no setuid binaries'
$suid = Invoke-InImage 'find / -xdev -perm /6000 -type f 2>/dev/null | grep -v /usr/bin/sudo || echo none'
if ($suid -notmatch 'none') { throw "unexpected setuid files: $suid" }
Write-Host '  none'

Write-Host '==> engine payload inventory'
$payload = Invoke-InImage 'find /opt/xash -maxdepth 1 -type f | sort | head -40'
$payload

if (-not $SmokeTest) {
    Write-Host "`nstatic checks passed (run with -SmokeTest for a render + encode check)" -ForegroundColor Green
    return
}

Write-Host '==> smoke test: game server + Xvfb + engine + ffmpeg to a local file'
docker rm -f cs16-stream-smoke cs16-smoke-hlds 2> $null | Out-Null
# STREAM_RTMP=/tmp plus a "key" that ends in .flv turns the RTMP target into a local recording,
# so the smoke test needs no YouTube key and no network.
#
# A real game server runs next to the capture container: without it the client would sit in its
# main menu, and the menu is bright (mean luma ~60) while the game is not (~40), so the join is
# checked by measuring the frame instead of trusting the logs.
docker volume create cs16-smoke-server 2> $null | Out-Null
docker volume create cs16-smoke-client 2> $null | Out-Null
docker network create cs16-smoke-net 2> $null | Out-Null
docker run --rm --entrypoint /bin/sh -v cs16-smoke-server:/hlds $ServerImage -c 'ls /hlds/cstrike > /dev/null' 2> $null
if ($LASTEXITCODE -ne 0) { throw "could not fill the server volume from $ServerImage" }
# Docker creates a fresh volume owned by root; the container runs as uid 10002.
docker run --rm --user root --entrypoint /bin/sh -v cs16-smoke-client:/game $Image -c 'chown 10002:10002 /game' | Out-Null

docker run -d --name cs16-smoke-hlds --network cs16-smoke-net `
    -v cs16-smoke-server:/hlds `
    -e RCON_PASSWORD=smoke-rcon -e MAP=de_dust2 $ServerImage | Out-Null
docker run -d --name cs16-stream-smoke --network cs16-smoke-net `
    -v cs16-smoke-server:/server:ro `
    -v cs16-smoke-client:/game `
    -e YOUTUBE_STREAM_KEY=smoke.flv `
    -e STREAM_RTMP=/tmp `
    -e SERVER_ADDR=cs16-smoke-hlds:27015 `
    -e STREAM_WIDTH=640 -e STREAM_HEIGHT=480 -e STREAM_FPS=15 `
    $Image | Out-Null

try {
    # Native tools write diagnostics to stderr (a growing FLV makes ffprobe complain); Windows
    # PowerShell 5.1 turns that into a terminating error while $ErrorActionPreference is 'Stop',
    # so failures are tracked through $LASTEXITCODE instead.
    $ErrorActionPreference = 'Continue'
    $waited = 0
    $size = 0
    $joined = $false
    while ($waited -lt $SmokeTimeoutSec) {
        Start-Sleep -Seconds 15
        $waited += 15
        $logs = (docker logs cs16-stream-smoke 2>&1) -join "`n"
        if ($logs -match 'Xvfb did not start') { $logs | Select-Object -Last 20; throw 'Xvfb failed to start' }
        if ($logs -match 'copy of (valve|cstrike) failed') { $logs | Select-Object -Last 20; throw 'game content copy failed' }
        # The server is the authority on the join: luma cannot tell the menu from a bright map.
        $serverLog = (docker logs cs16-smoke-hlds 2>&1) -join "`n"
        if ($serverLog -match 'StreamCam.*entered the game') { $joined = $true }
        if ($logs -match 'starting ffmpeg') {
            $size = docker exec cs16-stream-smoke stat -c %s /tmp/smoke.flv 2>&1
            # 60 s of encoded video is well above this; the first seconds are the menu/connect.
            if ($joined -and [int]$size -gt 2000000) { break }
        }
        Write-Host "  waiting: joined=$joined, file ${size} bytes (${waited}s)"
    }
    # Joined into one string: `-notmatch` on an array filters elements instead of testing the text,
    # so an array would make every pattern check "true".
    $logs = (docker logs cs16-stream-smoke 2>&1) -join "`n"
    if ($logs -notmatch 'starting ffmpeg') { $logs | Select-Object -Last 25; throw 'ffmpeg never started' }
    if (-not $joined) {
        $serverLog | Select-Object -Last 15
        throw 'the capture client never joined the game server'
    }
    if ([int]$size -le 2000000) { throw "ffmpeg wrote almost nothing in ${SmokeTimeoutSec}s" }

    # Stop the encoder so the FLV gets its trailer, then read that finalized file.
    docker exec cs16-stream-smoke pkill -f x11grab 2>&1 | Out-Null
    Start-Sleep -Seconds 3
    docker exec cs16-stream-smoke cp /tmp/smoke.flv /tmp/snapshot.flv 2>&1 | Out-Null
    $frames = docker exec cs16-stream-smoke ffprobe -v error -select_streams v -count_frames `
        -show_entries stream=nb_read_frames -of csv=p=0 /tmp/snapshot.flv 2>&1 | Select-Object -Last 1
    Write-Host "  file grew to $size bytes, frames: $frames"
    if ([int]$frames -le 0) { throw 'no video frames were written' }

    # The last seconds of the recording must not be a black screen.
    $stats = docker exec cs16-stream-smoke ffmpeg -hide_banner -i /tmp/snapshot.flv `
        -vf 'signalstats,metadata=print:key=lavfi.signalstats.YAVG' -f null - 2>&1
    $yavg = @($stats | Select-String -Pattern 'YAVG=([0-9.]+)' | ForEach-Object { [double]$_.Matches[0].Groups[1].Value })
    if ($yavg.Count -eq 0) { throw 'could not read YAVG from signalstats' }
    $tail = $yavg | Select-Object -Last 30
    $mean = ($tail | Measure-Object -Average).Average
    Write-Host ("  mean luma of the last frames: {0:N1}" -f $mean)
    # Not a menu/game discriminator: de_dust2 at 640x480 is bright (~120) and the main menu is ~60,
    # so the join was checked through the server log above. This only proves the screen is alive.
    if ($mean -lt 5) { throw 'the captured screen is black: the engine did not render' }

    Write-Host "`nsmoke test passed" -ForegroundColor Green
}
finally {
    $ErrorActionPreference = 'Continue'
    docker rm -f cs16-stream-smoke cs16-smoke-hlds 2> $null | Out-Null
    docker network rm cs16-smoke-net 2> $null | Out-Null
}
