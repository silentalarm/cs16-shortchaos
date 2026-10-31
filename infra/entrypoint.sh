#!/bin/bash
# Runtime entrypoint: injects secrets from the environment, then starts HLDS.
set -euo pipefail

: "${RCON_PASSWORD:?RCON_PASSWORD must be set, refusing to run an open server}"
MAP="${MAP:-fy_iceworld}"
# The map cycle the engine falls back to (nextmap, a bare `changelevel`). mp_timelimit is 0 and the
# duel owns the rotation, so this is only a safety net - but it must not list stock maps either:
# that is how a stream ends up on de_dust2 after an unrelated restart. One name per line.
MAPCYCLE="${MAPCYCLE:-fy_iceworld,fy_pool_day,fy_snow,fy_buzzkill,fy_simpsons,fy_aztec,fy_dustworld}"
MAXPLAYERS="${MAXPLAYERS:-22}"
PORT="${PORT:-27015}"
SERVER_CFG=/hlds/cstrike/server.cfg
AMXX=/hlds/cstrike/addons/amxmodx
DEFAULTS=/opt/defaults

# /hlds is a named volume, and Docker seeds it from the image only once. Without this sync a rebuilt
# plugin or an edited server.cfg would never reach an existing volume, so an image update would look
# like it did nothing. The files below are all generated from the repository, so overwriting is safe.
if [ -d "$DEFAULTS" ]; then
  if [ -f "$DEFAULTS/server.cfg" ]; then cp -f "$DEFAULTS/server.cfg" "$SERVER_CFG"; fi
  if [ -f "$DEFAULTS/plugins.ini" ]; then cp -f "$DEFAULTS/plugins.ini" "$AMXX/configs/plugins.ini"; fi
  if [ -f "$DEFAULTS/modules.ini" ]; then cp -f "$DEFAULTS/modules.ini" "$AMXX/configs/modules.ini"; fi
  if [ -d "$DEFAULTS/plugins" ]; then
    cp -f "$DEFAULTS/plugins"/*.amxx "$AMXX/plugins/" 2>/dev/null || true
  fi
  # The models this repository makes for itself. Without this they stay in the image and the plugin's
  # `file_exists` sees nothing, so the event runs without its picture and nothing in the log says why.
  if [ -d "$DEFAULTS/models" ]; then
    mkdir -p /hlds/cstrike/models
    cp -f "$DEFAULTS/models"/*.mdl /hlds/cstrike/models/ 2>/dev/null || true
    # Player models live one folder down, the way CS keeps its own: models/player/<name>/<name>.mdl.
    if [ -d "$DEFAULTS/models/player" ]; then
      mkdir -p /hlds/cstrike/models/player
      cp -rf "$DEFAULTS/models/player/." /hlds/cstrike/models/player/ 2>/dev/null || true
    fi
  fi
  # A sound the client does not have is a silent bang, and `precache_sound` says nothing about it: the
  # freeze sample is synced here for the same reason the models are.
  if [ -d "$DEFAULTS/sound" ]; then
    mkdir -p /hlds/cstrike/sound
    cp -rf "$DEFAULTS/sound/." /hlds/cstrike/sound/ 2>/dev/null || true
  fi
  echo "configs, plugins, models and sounds synced from the image"
fi

# The image never contains a usable rcon password; it is written at start.
sed -i -E "s|^rcon_password.*$|rcon_password \"${RCON_PASSWORD}\"|" "$SERVER_CFG"
grep -q '^rcon_password' "$SERVER_CFG" || echo "rcon_password \"${RCON_PASSWORD}\"" >> "$SERVER_CFG"

# sv_lan is read when the server object is created (before the map loads) and server.cfg is
# executed after that, so a command-line `+sv_lan` is always overridden by this file. Patching
# the file is the only order that works. LAN mode alone is not enough: the engine still asks
# Steam to validate the client ticket unless it is started with -insecure, and the capture client
# is an open-source engine without a ticket ("STEAM validation rejected" otherwise).
sed -i -E "s|^sv_lan.*$|sv_lan ${SV_LAN:-1}|" "$SERVER_CFG"
grep -q '^sv_lan' "$SERVER_CFG" || echo "sv_lan ${SV_LAN:-1}" >> "$SERVER_CFG"
chmod 600 "$SERVER_CFG" || true

# YaPB re-executes its own conf/yapb.cfg on every map change, and that silently reverts cvars set in
# server.cfg: verified live, yb_radio_mode went back to 2 and the bot chat spam returned in the
# middle of a stream while yb_quota stayed put. Appending our values makes them the last
# assignment the bot plugin sees, and the guard keeps the file from growing on every restart.
YAPB_CFG=/hlds/cstrike/addons/yapb/conf/yapb.cfg
if [ -f "$YAPB_CFG" ] && ! grep -q "cs16-youtube overrides" "$YAPB_CFG"; then
  {
    echo "// cs16-youtube overrides: this file is re-executed on every map change"
    echo "yb_radio_mode \"${BOT_RADIO_MODE:-0}\""
    echo "yb_chat \"0\""
    echo "yb_chat_percent \"0\""
    echo "yb_display_welcome_text \"0\""
    echo "yb_autovacate \"0\""
    echo "yb_quota \"${BOT_QUOTA:-20}\""
  } >> "$YAPB_CFG"
  echo "yapb.cfg: chat and radio disabled, quota ${BOT_QUOTA:-20}"
fi

# Custom maps, dropped in by the operator: `infra/maps` is mounted read-only at maps-extra (see
# infra/docker-compose.yml) and copied into the server's own directories here. The image itself never
# downloads a map, so nothing unverified enters the build; a stock file is never overwritten.
#
# Placement matters: a .bsp in maps/ is the map, but the .wad next to it is not - HLDS looks for wads
# in cstrike/ and dies with "TEX_InitFromWad: couldn't open de_vegas.wad" when it cannot find one
# (fy_iceworld ships de_vegas.wad). Sounds, sprites and models have their own directories too.
MAPS_EXTRA=/hlds/cstrike/maps-extra
if [ -d "$MAPS_EXTRA" ]; then
  files=0
  for file in "$MAPS_EXTRA"/*; do
    [ -f "$file" ] || continue
    name=$(basename "$file")
    case "$name" in
      *.bsp|*.res|*.nav|*.txt) dest=/hlds/cstrike/maps ;;
      *.wad) dest=/hlds/cstrike ;;
      *.wav|*.mp3) dest=/hlds/cstrike/sound ;;
      *.spr) dest=/hlds/cstrike/sprites ;;
      *.mdl) dest=/hlds/cstrike/models ;;
      *) continue ;;
    esac
    [ -e "$dest/$name" ] && continue
    mkdir -p "$dest"
    if cp "$file" "$dest/" 2>/dev/null; then files=$((files + 1)); fi
  done
  echo "maps: ${files} file(s) added from maps-extra"
fi

# Stock mapcycle.txt lists the 25 maps HLDS ships with; the stream is a fight-yard stream, so the
# safety net is rewritten from MAPCYCLE every start. mp_timelimit 0 means only the duel changes the
# map, and that uses map_duel_maps - this file exists so nothing can silently pick de_dust2.
printf '%s\n' "$MAPCYCLE" | tr ',' '\n' | sed '/^$/d' > /hlds/cstrike/mapcycle.txt
echo "mapcycle: $(tr '\n' ' ' < /hlds/cstrike/mapcycle.txt)"

# First person camera: 0 = the chase camera only (the default picture), 1 = after the bot on camera
# gets a kill the capture client is cut into its eyes for stcam_pov_sec seconds (plugins/stream_cam).
# Patched into server.cfg rather than passed on the command line: the plugin re-reads its cvars on
# every map change, and one env var is the whole switch, so the feature can be turned off per host.
sed -i -E "s|^stcam_pov .*$|stcam_pov ${STREAM_POV:-0}|" "$SERVER_CFG" 2>/dev/null || true
grep -q '^stcam_pov ' "$SERVER_CFG" || echo "stcam_pov ${STREAM_POV:-0}" >> "$SERVER_CFG"

echo "starting hlds: map=${MAP} maxplayers=${MAXPLAYERS} port=${PORT} sv_lan=${SV_LAN:-1}"
exec /hlds/hlds_run \
  -game cstrike \
  -insecure \
  -console \
  -port "$PORT" \
  +maxplayers "$MAXPLAYERS" \
  +map "$MAP" \
  +exec server.cfg
