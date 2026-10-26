#!/bin/bash
# One-off probe: fetch the official `steam_legacy` branch of app 90 (depot 4, linux)
# and check whether its steamclient.so still exports SteamGameServer_Init.
set -euo pipefail

MANIFEST="${1:-8690279432129063737}"

/s/steamcmd.sh +login anonymous +download_depot 90 4 "$MANIFEST" +quit

SRC=$(ls -d /s/linux32/steamapps/content/app_90/depot_4 /root/Steam/steamapps/content/app_90/depot_4 2>/dev/null | head -1)
echo "depot dir: ${SRC:-not found}"
mkdir -p /out
cp -a "$SRC"/. /out/ 2>/dev/null || true

echo "=== files ==="
ls -1 /out | head -30
echo "=== engine + steam libs ==="
ls -l /out/*.so /out/hlds_linux 2>/dev/null | head -10 || true
echo "=== symbol check ==="
for f in /out/steamclient.so /out/linux32/steamclient.so; do
  [ -f "$f" ] || continue
  n=$(grep -c "SteamGameServer_Init" "$f" || true)
  echo "$f -> SteamGameServer_Init hits: $n"
done
