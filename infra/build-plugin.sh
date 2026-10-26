#!/bin/bash
# Compiles the Pawn plugin inside the image. Kept in its own layer: amxxpc is a 32-bit
# binary and needs libc6-i386, so the compiler dependencies can change without rebuilding
# (and re-downloading) the whole game server.
set -euo pipefail

HLDS=/hlds
AMXX="$HLDS/cstrike/addons/amxmodx"

test -f "$AMXX/scripting/amxxpc" || { echo "FATAL: amxxpc is missing, AMX Mod X was not unpacked" >&2; exit 1; }

chmod +x "$AMXX/scripting/amxxpc" "$AMXX/scripting/amxxpc32.so" 2>/dev/null || true

# Every plugin directory under /src/plugins is one plugin: <dir>/<dir>.sma -> plugins/<dir>.amxx.
# Adding a plugin therefore needs no change to this script, only a line in infra/plugins.ini.
compiled=0
for source in /src/plugins/*/*.sma; do
  [ -f "$source" ] || continue
  name="$(basename "$source" .sma)"
  mkdir -p "$AMXX/scripting/$name"
  cp "$source" "$AMXX/scripting/$name/"
done

# amxxpc dlopens amxxpc32.so relative to the working directory, so run it from scripting/.
cd "$AMXX/scripting"
status=0
for source in /src/plugins/*/*.sma; do
  [ -f "$source" ] || continue
  name="$(basename "$source" .sma)"
  ./amxxpc "$name/$name.sma" -i"include" -o"$AMXX/plugins/$name.amxx" || status=1
  test -f "$AMXX/plugins/$name.amxx" || { echo "FATAL: $name.amxx is missing" >&2; status=1; }
  compiled=$((compiled + 1))
done

[ "$compiled" -gt 0 ] || { echo "FATAL: no plugin sources under /src/plugins" >&2; status=1; }

# The compiler is build tooling: it must not ship inside the runtime image.
rm -f "$AMXX/scripting/amxxpc" "$AMXX/scripting/amxxpc32.so"

[ "$status" -eq 0 ] || { echo "FATAL: a plugin did not compile" >&2; exit 1; }
echo "==> ${compiled} plugin(s) compiled into $AMXX/plugins"

