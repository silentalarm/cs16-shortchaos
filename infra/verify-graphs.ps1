# Are the navigation graphs in the server volume the ones pinned in the repository?
#
#   powershell -File infra/verify-graphs.ps1
#
# `infra/entrypoint.sh` copies a graph in only when the volume has no graph of that name: a graph the bot
# built on the running server was analyzed with the current `yb_graph_analyze_*` values, so overwriting it
# on every start is how the tuning never took effect. The flip side is a volume that keeps a graph from an
# older, sparser analysis, and the symptom is exactly the one the dense graphs were meant to cure - a bot
# with nowhere to path that grinds a wall. This compares by content (`cmp`, exit status), which needs no
# RCON and no running server. `stale` means the volume's copy is not the pinned one.
[CmdletBinding()]
param(
    [string]$Image = 'cs16-stream:local',
    [string]$Volume = 'cs16-youtube_server-data'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$repo = Join-Path $root 'infra/maps/graph'
if (-not (Test-Path $repo)) { throw "no pinned graphs at $repo" }

$stale = @()
$checked = 0
foreach ($file in Get-ChildItem -Path $repo -Filter *.graph | Sort-Object Name) {
    # `cmp` as the entrypoint: one container per map, no shell quoting to relay into Windows PowerShell.
    docker run --rm --entrypoint /usr/bin/cmp `
        -v "${repo}:/pinned:ro" -v "${Volume}:/hlds:ro" `
        $Image "/pinned/$($file.Name)" "/hlds/cstrike/addons/yapb/data/graph/$($file.Name)" 2>&1 | Out-Null

    $checked++
    if ($LASTEXITCODE -eq 0) {
        Write-Host ("  same   {0} ({1} KB)" -f $file.Name, [math]::Round($file.Length / 1KB))
    }
    elseif ($LASTEXITCODE -eq 2) {
        # The volume has no graph of that name: the entrypoint adds it on the next start.
        Write-Host ("  absent {0}" -f $file.Name)
    }
    else {
        Write-Host ("  STALE  {0} ({1} KB pinned)" -f $file.Name, [math]::Round($file.Length / 1KB))
        $stale += $file.Name
    }
}

Write-Host ""
if ($stale.Count -gt 0) {
    Write-Host "stale in the volume: $($stale -join ', ')"
    Write-Host "re-analyze on the server (see docs/runbook.md, 'Navigation graphs') or drop the file and restart:"
    foreach ($name in $stale) {
        Write-Host "  docker run --rm -v ${Volume}:/hlds --entrypoint sh cs16-hlds:local -c 'rm -f /hlds/cstrike/addons/yapb/data/graph/$name'"
    }
    exit 1
}

Write-Host "all $checked pinned graph(s) match the volume"
