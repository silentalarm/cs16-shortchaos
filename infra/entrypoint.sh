#!/bin/bash
# Runtime entrypoint: injects secrets from the environment, then starts HLDS.
set -euo pipefail

: "${RCON_PASSWORD:?RCON_PASSWORD must be set, refusing to run an open server}"
MAP="${MAP:-aim_map}"
# The map cycle the engine falls back to (nextmap, a bare `changelevel`). mp_timelimit is 0 and the
# duel owns the rotation, so this is only a safety net - but it must not list stock maps either:
# that is how a stream ends up on de_dust2 after an unrelated restart. One name per line.
MAPCYCLE="${MAPCYCLE:-aim_map,aim_headshot,aim_map_2010,aim_aztecplace,aim_dust2011,aim_aspect,fy_iceworld}"
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
    # Player models live one folder down, the way CS keeps its own: models/player/<name>/<name>.mdl. Only
    # the .mdl files: the folder next to each of them also holds the build's own report pictures (the
    # painted sheet, the sheet of views, `infra/models/build/*.mjs`), and those are not part of the model -
    # in the volume they only travel on to every client that joins.
    for from in "$DEFAULTS/models/player"/*/; do
      [ -d "$from" ] || continue
      to="/hlds/cstrike/models/player/$(basename "$from")"
      mkdir -p "$to"
      cp -f "$from"*.mdl "$to/" 2>/dev/null || true
    done
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
# middle of a stream while yb_quota stayed put. The block below is appended at the end of that file,
# because the last assignment is the one the plugin sees.
#
# It is rewritten on every start, not appended once: the first version guarded on a marker with
# `grep -q`, so a tuned value never reached an existing volume and the edit looked like it did
# nothing. Our own lines are deleted by name first (the archive's defaults for them come back with
# the block below), which also removes that older, marker-less version.
#
# The YaPB archive ships data/train, data/logs and data/pwf as *directories* with mode 0644, and a
# directory without the execute bit cannot be written into. Every map load therefore logged
#   Unable to open Pathmatrix file for writing (filename: '.../data/train/fy_iceworld.pmx')
#   Unable to open Vistable file for writing (filename: '.../data/train/fy_iceworld.vis')
# and the path matrix and visibility table were never kept: the bot recomputed its routes every round
# and mis-guessed which connections are clear, which is what "the bots walk into walls" looks like.
YAPB_DATA=/hlds/cstrike/addons/yapb/data
if [ -d "$YAPB_DATA" ]; then
  for dir in graph logs pwf train; do
    mkdir -p "$YAPB_DATA/$dir" 2>/dev/null || true
    chmod 755 "$YAPB_DATA/$dir" 2>/dev/null || true
  done
fi

YAPB_CFG=/hlds/cstrike/addons/yapb/conf/yapb.cfg
if [ -f "$YAPB_CFG" ]; then
  sed -i -E '/cs16-youtube overrides/d' "$YAPB_CFG"
  sed -i -E '/^yb_(radio_mode|chat|chat_percent|display_welcome_text|autovacate|quota|difficulty|shoots_thru_walls|camping_allowed|camping_time_min|camping_time_max|walking_allowed|has_team_semiclip|random_knife_attacks|graph_analyze_distance|graph_analyze_optimize_nodes_on_finish)[[:space:]]/d' "$YAPB_CFG"
  {
    echo "// cs16-youtube overrides: rewritten on every start, keep this block last"
    echo "yb_radio_mode \"${BOT_RADIO_MODE:-0}\""
    echo "yb_chat \"0\""
    echo "yb_chat_percent \"0\""
    echo "yb_display_welcome_text \"0\""
    echo "yb_autovacate \"0\""
    echo "yb_quota \"${BOT_QUOTA:-20}\""
    # Aim at what a good human does instead of at what the bot can do: Hard (3) reacts in 0.2-0.4 s,
    # goes for the head 75% of the time and fires at a remembered enemy through the wall in 60% of the
    # cases. Normal (2) reacts in 0.4-0.6 s at 50%, and with wall shooting off the tell that breaks the
    # illusion on a stream is gone.
    echo "yb_difficulty \"${BOT_DIFFICULTY:-2}\""
    echo "yb_shoots_thru_walls \"0\""
    # Holding an angle is human; never stopping is not. 10-30 s (the first setting) is a third of a
    # fight on fy_iceworld and reads as "the bots are asleep" on a 24/7 feed; 4-12 s keeps the picture
    # moving and still lets a bot watch a doorway. bot_antistuck is told to ignore a bot that is only
    # holding one (see plugins/bot_antistuck).
    echo "yb_camping_allowed \"1\""
    echo "yb_camping_time_min \"4.0\""
    echo "yb_camping_time_max \"12.0\""
    # yb_walking_allowed: the bot re-executes this file on every map change, so the 0 in server.cfg is
    # reverted to the archive's 1 - a bot then crouch-walks whenever it thinks an enemy is near, which
    # from the outside is a bot that stopped.
    echo "yb_walking_allowed \"0\""
    # Told, not done: the bot only needs to know that a teammate is not an obstacle. The collision itself
    # is removed by team_semiclip (plugins/team_semiclip), and without this line a bot still refuses to
    # path through the body standing in the doorway.
    echo "yb_has_team_semiclip \"1\""
    # yb_random_knife_attacks is not "bot duels with a knife": it lets a bot run with the knife out
    # while it rushes and no enemy is nearby, which is exactly what a human does on a rotation and what
    # a bot holding a rifle in an empty corridor does not. The knife *fight* is the other knob -
    # yb_stab_close_enemies - and that one stays 0 in server.cfg, because a bot that stabs instead of
    # shooting reads as broken. Verified against the cvar comments in cfg/addons/yapb/conf/yapb.cfg.
    echo "yb_random_knife_attacks \"${BOT_KNIFE_ATTACKS:-1}\""
    # Navigation graph density for the fy_* pool, which the bot analyzes itself (the archive ships no
    # graph for those maps): 64 units between nodes leaves too few links in a tight corner, and the
    # optimizer drops nodes a corridor needs. 48 is as dense as the bot accepts - YaPB clamps the value
    # to 42..128 and reverts anything outside it with "Bogus value for cvar" (40 was tried and ignored).
    echo "yb_graph_analyze_distance \"48\""
    echo "yb_graph_analyze_optimize_nodes_on_finish \"0\""
  } >> "$YAPB_CFG"
  echo "yapb.cfg: chat and radio off, quota ${BOT_QUOTA:-20}, difficulty ${BOT_DIFFICULTY:-2}"
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

# Navigation graphs for those maps. YaPB 4.4 loads addons/yapb/data/graph/<map>.graph - never a .nav -
# and ships a graph for the stock maps only, so a fresh volume would start with a bot that has to
# analyze a fight-yard map first.
#
# Copied only when the volume has no graph of that name. A graph the bot built on this very server is
# better than the one in git whenever the two disagree (it was analyzed with the current
# yb_graph_analyze_* values, on the running build), and clobbering it on every restart is how the
# tuning below never took effect. The repository copy is the baseline for a volume that has none.
if [ -n "$YAPB_DATA" ] && [ -d "$MAPS_EXTRA/graph" ]; then
  graphs=0
  mkdir -p "$YAPB_DATA/graph"
  for file in "$MAPS_EXTRA"/graph/*.graph; do
    [ -f "$file" ] || continue
    name=$(basename "$file")
    [ -e "$YAPB_DATA/graph/$name" ] && continue
    if cp -f "$file" "$YAPB_DATA/graph/" 2>/dev/null; then graphs=$((graphs + 1)); fi
  done
  echo "yapb graphs: ${graphs} file(s) added"
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
