#!/bin/bash
# Compiles CSDM from the pinned source tree. Kept separate from build-plugin.sh because CSDM is
# third-party code we do not modify: its sources live outside /src/plugins and are deleted after
# the build, so the runtime image ships only .amxx files.
set -euo pipefail

SRC=/opt/csdm-src
HLDS=/hlds
AMXX="$HLDS/cstrike/addons/amxmodx"

test -d "$SRC" || { echo "FATAL: CSDM sources are missing at $SRC" >&2; exit 1; }
test -x "$AMXX/scripting/amxxpc" || { echo "FATAL: amxxpc is missing, CSDM must be compiled before build-plugin.sh removes it" >&2; exit 1; }

# Only what a bot-only grinder needs. csdm_ffa (off by design), csdm_itemmode, csdm_tickets and
# spawn_editor are deliberately not built: every extra plugin is another hook on DeathMsg.
MODULES="csdm_main csdm_equip csdm_spawn_preset csdm_misc csdm_protection"

mkdir -p "$AMXX/scripting/csdm"
cp -f "$SRC"/csdm_*.sma "$AMXX/scripting/csdm/"
# csdm.inc and its friends: the compiler resolves #include from scripting/include.
if [ -d "$SRC/include" ]; then cp -f "$SRC"/include/*.inc "$AMXX/scripting/include/"; fi

cd "$AMXX/scripting"
status=0
for module in $MODULES; do
    ./amxxpc "csdm/$module.sma" -i"include" -o"$AMXX/plugins/$module.amxx" || status=1
    test -f "$AMXX/plugins/$module.amxx" || { echo "FATAL: $module.amxx is missing" >&2; status=1; }
done

# Sources and the compiler are build tooling.
rm -rf "$AMXX/scripting/csdm"

[ "$status" -eq 0 ] || { echo "FATAL: CSDM did not compile" >&2; exit 1; }
echo "==> CSDM compiled: $MODULES"
