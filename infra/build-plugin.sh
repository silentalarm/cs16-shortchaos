#!/bin/bash
# Compiles the Pawn plugin inside the image. Kept in its own layer: amxxpc is a 32-bit
# binary and needs libc6-i386, so the compiler dependencies can change without rebuilding
# (and re-downloading) the whole game server.
set -euo pipefail

HLDS=/hlds
AMXX="$HLDS/cstrike/addons/amxmodx"
SOURCE=/src/plugins/donation_events/donation_events.sma

test -f "$AMXX/scripting/amxxpc" || { echo "FATAL: amxxpc is missing, AMX Mod X was not unpacked" >&2; exit 1; }

mkdir -p "$AMXX/scripting/donation_events"
cp "$SOURCE" "$AMXX/scripting/donation_events/"
chmod +x "$AMXX/scripting/amxxpc" "$AMXX/scripting/amxxpc32.so" 2>/dev/null || true

# amxxpc dlopens amxxpc32.so relative to the working directory, so run it from scripting/.
cd "$AMXX/scripting"
./amxxpc \
  "donation_events/donation_events.sma" \
  -i"include" \
  -o"$AMXX/plugins/donation_events.amxx" \
  || { echo "FATAL: plugin did not compile" >&2; exit 1; }

test -f "$AMXX/plugins/donation_events.amxx" || { echo "FATAL: plugin binary missing" >&2; exit 1; }

# The compiler is build tooling: it must not ship inside the runtime image.
rm -f "$AMXX/scripting/amxxpc" "$AMXX/scripting/amxxpc32.so"

echo "==> plugin compiled: $AMXX/plugins/donation_events.amxx"

