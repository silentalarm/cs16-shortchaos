#!/bin/bash
# Assembles the CS 1.6 server: official HLDS content via SteamCMD, then official ReHLDS,
# ReGameDLL_CS, Metamod-R, AMX Mod X and YaPB releases, each pinned by SHA256.
# Fails loudly when a checksum or an expected file is missing: a silently wrong server is
# worse than a broken build.
set -euo pipefail

WORK=/root/src
STEAM=/var/cache/steamcmd
HLDS=/hlds
mkdir -p "$WORK" "$HLDS" "$STEAM"

fetch() {
  local name="$1" url="$2" sha="$3" dest="$4"
  if [[ -z "$url" || -z "$sha" ]]; then
    echo "FATAL: $name has no url/sha256 (run infra/update-checksums.ps1)" >&2
    exit 1
  fi
  echo "==> $name"
  curl -fsSL --retry 3 --retry-delay 2 "$url" -o "$dest"
  echo "$sha  $dest" | sha256sum -c - >/dev/null
}

echo "==> SteamCMD (Valve)"
curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz -o "$WORK/steamcmd.tar.gz"
mkdir -p "$STEAM/bin"
tar -xzf "$WORK/steamcmd.tar.gz" -C "$STEAM/bin"
# HLDS needs several update passes on a cold cache; the loop stops when app 90 is complete.
for attempt in 1 2 3 4; do
  echo "--- HLDS update pass $attempt"
  "$STEAM/bin/steamcmd.sh" +force_install_dir "$HLDS" +login anonymous +app_update 90 validate +quit || true
  [[ -x "$HLDS/hlds_run" ]] && break
done
test -x "$HLDS/hlds_run" || { echo "FATAL: HLDS was not installed" >&2; exit 1; }

# The current public HLDS depot ships a steamclient.so that no longer exports
# SteamGameServer_Init (Valve bumped the Steamworks SDK), and ReHLDS/Metamod-R need it.
# Valve keeps the pre-25th-anniversary build as the `steam_legacy` branch, so pin that
# linux depot manifest and take the engine libraries from it. Verified against a live
# server: with these libraries ReHLDS + Metamod-R + AMX Mod X boot and accept rcon.
LEGACY_MANIFEST="${STEAM_LEGACY_MANIFEST:-8690279432129063737}"
echo "==> HLDS legacy engine libraries (app 90 depot 4, manifest $LEGACY_MANIFEST)"
"$STEAM/bin/steamcmd.sh" +login anonymous +download_depot 90 4 "$LEGACY_MANIFEST" +quit
LEGACY_DIR="$(find "$STEAM" "$HOME/Steam" /root -maxdepth 8 -type d -name depot_4 2>/dev/null | head -1)"
test -n "$LEGACY_DIR" || { echo "FATAL: legacy HLDS depot was not downloaded" >&2; exit 1; }
test -f "$LEGACY_DIR/hlds_linux" || { echo "FATAL: legacy depot looks empty ($LEGACY_DIR)" >&2; exit 1; }

fetch "ReHLDS" "$REHLDS_URL" "$REHLDS_SHA256" "$WORK/rehlds.zip"
fetch "ReGameDLL_CS" "$REGAMEDLL_URL" "$REGAMEDLL_SHA256" "$WORK/regamedll.zip"
fetch "Metamod-R" "$METAMOD_URL" "$METAMOD_SHA256" "$WORK/metamod.zip"
fetch "AMX Mod X base" "$AMXX_BASE_URL" "$AMXX_BASE_SHA256" "$WORK/amxx-base.tar.gz"
fetch "AMX Mod X cstrike" "$AMXX_CSTRIKE_URL" "$AMXX_CSTRIKE_SHA256" "$WORK/amxx-cstrike.tar.gz"
fetch "YaPB" "$YAPB_URL" "$YAPB_SHA256" "$WORK/yapb.tar.xz"
fetch "CSDM" "$CSDM_URL" "$CSDM_SHA256" "$WORK/csdm.tar.gz"

mkdir -p "$WORK/rehlds" "$WORK/regamedll" "$WORK/metamod"
unzip -q -o "$WORK/rehlds.zip" -d "$WORK/rehlds"
unzip -q -o "$WORK/regamedll.zip" -d "$WORK/regamedll"
unzip -q -o "$WORK/metamod.zip" -d "$WORK/metamod"

# ReHLDS replaces the whole engine set: engine_i486.so alone is not enough, the other
# linux32 modules (core, filesystem_stdio, proxy, demoplayer) come from the same archive.
# On by default: the legacy depot above supplies the steamclient/libsteam_api pair that
# ReHLDS links against, so the hardened engine is the default rather than an opt-in.
if [[ "${WITH_REHLDS:-1}" == "1" ]]; then
  echo "==> ReHLDS enabled"
  find "$WORK/rehlds/bin/linux32" -maxdepth 1 -name '*.so' -exec cp -f {} "$HLDS/" \;
  test -f "$HLDS/engine_i486.so" || { echo "FATAL: ReHLDS engine not found in the archive" >&2; exit 1; }
  if [[ -d "$WORK/rehlds/bin/linux32/valve/dlls" ]]; then
    mkdir -p "$HLDS/valve/dlls"
    cp -f "$WORK/rehlds/bin/linux32/valve/dlls/"*.so "$HLDS/valve/dlls/"
  fi
else
  echo "==> ReHLDS disabled, keeping the Valve engine"
fi

# Engine libraries from the legacy depot go on top of the engine set chosen above, because
# they are the ones that still talk to Steam (ReHLDS' own proxy.so dies with
# "Unable to initialize Steam" against the current steamclient). With ReHLDS enabled the
# engine itself must stay: only the helper libraries are refreshed.
if [[ "${WITH_REHLDS:-1}" == "1" ]]; then
  echo "==> legacy engine libraries (keeping the ReHLDS engine)"
  for file in "$LEGACY_DIR"/*; do
    if [[ "$(basename "$file")" == "engine_i486.so" ]]; then
      continue
    fi
    cp -a "$file" "$HLDS"/
  done
else
  echo "==> legacy engine libraries (stock engine)"
  cp -a "$LEGACY_DIR"/. "$HLDS"/
fi

# The engine dlopen()s "$HLDS/.steam/sdk32/steamclient.so" before Steam init and dies with
# "Unable to initialize Steam" when it is missing (hlds_run then restarts into a working
# server, which hides the problem behind a boot delay). The legacy depot ships the same
# library as libsteam_api.so, so provide it under the name the engine looks for.
mkdir -p "$HLDS/.steam/sdk32"
cp -f "$HLDS/libsteam_api.so" "$HLDS/.steam/sdk32/steamclient.so"

cp -f "$HLDS/cstrike/dlls/cs.so" "$HLDS/cstrike/dlls/cs.so.valve"
if [[ "${WITH_REGAMEDLL:-0}" == "1" ]]; then
  echo "==> ReGameDLL enabled"
  cp -f "$WORK/regamedll/bin/linux32/cstrike/dlls/cs.so" "$HLDS/cstrike/dlls/cs.so"
else
  echo "==> ReGameDLL disabled, keeping the Valve game DLL"
fi
test -f "$HLDS/cstrike/dlls/cs.so" || { echo "FATAL: game DLL is missing" >&2; exit 1; }

mkdir -p "$HLDS/cstrike/addons/metamod"
cp -f "$WORK/metamod/addons/metamod/metamod_i386.so" "$HLDS/cstrike/addons/metamod/metamod_i386.so"
test -f "$HLDS/cstrike/addons/metamod/metamod_i386.so" || { echo "FATAL: Metamod-R not found" >&2; exit 1; }

# Metamod reads the game DLL from config.ini once liblist.gam points at Metamod itself;
# without this line it tries to load nothing and the engine dies with "Couldn't get DLL API".
cp -f "$WORK/metamod/addons/metamod/config.ini" "$HLDS/cstrike/addons/metamod/config.ini"
sed -i -E '/^gamedll[[:space:]]/d' "$HLDS/cstrike/addons/metamod/config.ini"
echo "gamedll dlls/cs.so" >> "$HLDS/cstrike/addons/metamod/config.ini"

tar -xzf "$WORK/amxx-base.tar.gz" -C "$HLDS/cstrike"
tar -xzf "$WORK/amxx-cstrike.tar.gz" -C "$HLDS/cstrike"
test -f "$HLDS/cstrike/addons/amxmodx/dlls/amxmodx_mm_i386.so" || { echo "FATAL: AMX Mod X not unpacked" >&2; exit 1; }

# YaPB's linux archive already mirrors cstrike/addons/yapb, so it unpacks over cstrike.
tar -xJf "$WORK/yapb.tar.xz" -C "$HLDS/cstrike"
test -f "$HLDS/cstrike/addons/yapb/bin/yapb.so" || { echo "FATAL: YaPB binary missing" >&2; exit 1; }

# CSDM: only the source tree is unpacked here. The plugins are compiled later, in the stage that
# has amxxpc (infra/build-csdm.sh), and the sources are deleted from the final image.
mkdir -p "$WORK/csdm" /opt/csdm-src
tar -xzf "$WORK/csdm.tar.gz" -C "$WORK/csdm" --strip-components=1
cp -a "$WORK/csdm/amxmodx/scripting/." /opt/csdm-src/
test -f /opt/csdm-src/csdm_main.sma || { echo "FATAL: CSDM sources not found" >&2; exit 1; }
# Spawn points ship with CSDM and are read by csdm_lite (csdm_spawn_preset is not loaded).
mkdir -p "$HLDS/cstrike/addons/amxmodx/configs/csdm"
cp -f "$WORK/csdm/amxmodx/configs/csdm/"*.spawns.cfg "$HLDS/cstrike/addons/amxmodx/configs/csdm/"
cp -f "$WORK/csdm/amxmodx/configs/csdm.cfg" "$HLDS/cstrike/addons/amxmodx/configs/csdm.cfg"

# Metamod loads the bot plugin, then AMX Mod X, then our plugin (see infra/plugins.ini).
cat > "$HLDS/cstrike/addons/metamod/plugins.ini" <<'EOF'
linux addons/yapb/bin/yapb.so
linux addons/amxmodx/dlls/amxmodx_mm_i386.so
EOF

# liblist.gam must load Metamod instead of the game DLL.
sed -i -E 's|^gamedll_linux.*$|gamedll_linux "addons/metamod/metamod_i386.so"|' "$HLDS/cstrike/liblist.gam"
grep -q 'addons/metamod/metamod_i386.so' "$HLDS/cstrike/liblist.gam" \
  || echo 'gamedll_linux "addons/metamod/metamod_i386.so"' >> "$HLDS/cstrike/liblist.gam"

AMXX="$HLDS/cstrike/addons/amxmodx"
# server.cfg and plugins.ini are installed by the *next* Dockerfile layer on purpose: they are the
# files edited most often, and copying them here would invalidate this layer, which re-downloads
# the whole game server (~800 MB) on every config tweak.
# No entrypoint copy on purpose: /hlds becomes a named volume at runtime, and files inside a
# volume are only seeded once, so an entrypoint stored there would never be updated. It lives in
# /usr/local/bin in the runtime stage instead.

echo "==> build finished"
ls -1 "$HLDS" | head -20
