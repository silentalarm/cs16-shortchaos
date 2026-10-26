#!/bin/bash
# Runtime entrypoint: injects secrets from the environment, then starts HLDS.
set -euo pipefail

: "${RCON_PASSWORD:?RCON_PASSWORD must be set, refusing to run an open server}"
MAP="${MAP:-de_dust2}"
MAXPLAYERS="${MAXPLAYERS:-16}"
PORT="${PORT:-27015}"
SERVER_CFG=/hlds/cstrike/server.cfg

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

echo "starting hlds: map=${MAP} maxplayers=${MAXPLAYERS} port=${PORT} sv_lan=${SV_LAN:-1}"
exec /hlds/hlds_run \
  -game cstrike \
  -insecure \
  -console \
  -port "$PORT" \
  +maxplayers "$MAXPLAYERS" \
  +map "$MAP" \
  +exec server.cfg
